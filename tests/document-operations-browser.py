#!/usr/bin/env python3
"""Local browser checks with a fully intercepted, fictional Supabase API.

Requires Python Playwright, pypdf and Chromium. Run from the repository root:
    python tests/document-operations-browser.py

The script starts its own Next development server with fake public settings,
blocks every nonlocal destination except the intercepted fixture hostname, and
stops only the process group that it created. It never uses a real database.
"""

import base64
import copy
import csv
from datetime import datetime, timezone
import http.client
from io import BytesIO, StringIO
import json
import os
import re
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright
from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[1]
API_HOST = "operation-test.supabase.co"
USER_ID = "11111111-1111-4111-8111-111111111111"
DOC_ID = "22222222-2222-4222-8222-222222222222"
CASE_ID = "33333333-3333-4333-8333-333333333333"
TYPE_ID = "44444444-4444-4444-8444-444444444444"
AGENCY_ID = "55555555-5555-4555-8555-555555555555"
LAWYER_ID = "66666666-6666-4666-8666-666666666666"
AUXILIARY_ID = "77777777-7777-4777-8777-777777777777"


def jwt_part(value):
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


class SupabaseFixture:
    def __init__(self, origin, scenario):
        self.origin = origin
        self.scenario = scenario
        self.operations = []
        self.deletions = []
        self.deletion_receipts = {}
        self.held_deletion = None
        self.archived_documents = []
        self.auth_attempts = []
        self.held_auth = None
        self.held_load = None
        self.reads = []
        self.creations = []
        self.case_creations = []
        self.held_case = None
        self.created_documents = {}
        self.creation_movements = 0
        self.catalog_writes = []
        self.dialog_types = []
        self.extra_documents = []
        self.direct_writes = []
        self.unexpected_hosts = []
        self.receipts = {}
        self.tick = 0
        self.held_lookup = None
        self.held_operation = None
        self.document = {
            "id": DOC_ID,
            "qr_token": "88888888-8888-4888-8888-888888888888",
            "label": "Original",
            "lawyer_id": LAWYER_ID,
            "auxiliary_id": AUXILIARY_ID,
            "folio_forma": None,
            "municipality": None,
            "cadastral_file_number": None,
            "deed_entries": [],
            "status": "EN_OFICINA",
            "last_movement_at": "2026-11-09T10:00:00.123456+00:00",
            "created_at": "2026-11-08T10:00:00+00:00",
            "archived_at": None,
            "case_files": {"number": "TEST-001"},
            "document_types": {"name": "CERTIFICADO"},
            "agencies": {"name": "REGISTRO PÚBLICO"},
        }
        self.rows = {
            "case_files": [{"id": CASE_ID, "number": "TEST-001"}],
            "document_types": [{"id": TYPE_ID, "name": "CERTIFICADO"}],
            "agencies": [{"id": AGENCY_ID, "name": "REGISTRO PÚBLICO"}],
            "lawyers": [{"id": LAWYER_ID, "name": "Abogado de prueba"}],
            "auxiliaries": [{"id": AUXILIARY_ID, "name": "Auxiliar de prueba"}],
            "municipalities": [],
            "profiles": [{"id": USER_ID, "username": "prueba", "role": "admin"}],
        }
        self.movements = []

    def fulfill(self, route, data, status=200):
        route.fulfill(
            status=status,
            headers={
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": self.origin,
                "Access-Control-Allow-Credentials": "true",
                "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-client-info,prefer,range,range-unit",
                "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
            },
            body=json.dumps(data),
        )

    def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        if parsed.hostname in {"127.0.0.1", "localhost"}:
            route.continue_()
            return
        if parsed.hostname != API_HOST:
            self.unexpected_hosts.append(parsed.hostname)
            route.abort("blockedbyclient")
            return
        if request.method == "OPTIONS":
            self.fulfill(route, {})
            return
        if parsed.path.startswith("/auth/v1/"):
            if parsed.path.endswith("/token"):
                self.auth_attempts.append(copy.deepcopy(request.post_data_json))
                failures = {
                    "auth_credentials": (400, "invalid_credentials", "Invalid login credentials"),
                    "auth_rate": (429, "over_request_rate_limit", "Fictional rate limit"),
                    "auth_service": (503, "unexpected_failure", "Fictional service outage"),
                    "auth_unconfirmed": (400, "email_not_confirmed", "Fictional unconfirmed email"),
                }
                if self.scenario in failures:
                    status, code, message = failures[self.scenario]
                    self.fulfill(route, {"code": code, "error_code": code, "msg": message}, status)
                    return
                if self.scenario == "auth_connection":
                    route.abort("connectionfailed")
                    return
                if self.scenario == "auth_delayed":
                    self.held_auth = route
                    return
            self.respond_auth(route, parsed.path)
            return
        if parsed.path == "/rest/v1/rpc/get_database_storage_usage":
            self.fulfill(route, 28 * 1024 * 1024)
            return
        if parsed.path == "/rest/v1/rpc/save_document_operation":
            args = request.post_data_json
            self.operations.append(copy.deepcopy(args))
            if self.scenario == "delayed_scan":
                self.held_operation = (route, args)
            else:
                self.respond_operation(route, args)
            return
        if parsed.path == "/rest/v1/rpc/delete_archived_document":
            args = request.post_data_json
            self.deletions.append(copy.deepcopy(args))
            if self.scenario == "deletion_delayed":
                self.held_deletion = (route, args)
            else:
                self.respond_deletion(route, args)
            return
        if parsed.path.startswith("/rest/v1/"):
            table = parsed.path.split("/")[-1]
            if table == "case_files" and request.method == "POST" and self.scenario.startswith("case_"):
                data = copy.deepcopy(request.post_data_json)
                self.case_creations.append(data)
                if self.scenario in {"case_delayed", "case_timeout"} and len(self.case_creations) == 1:
                    self.held_case = (route, data)
                else:
                    self.respond_case_creation(route, data)
                return
            if table in {"document_types", "agencies"} and request.method == "POST" and self.scenario.startswith("creation"):
                data = copy.deepcopy(request.post_data_json)
                self.catalog_writes.append({"table": table, "data": data})
                row = {"id": f"cccccccc-cccc-4ccc-8ccc-{len(self.catalog_writes):012d}", **data}
                self.rows[table].append(row)
                self.fulfill(route, row, 201)
                return
            if table == "documents" and request.method == "POST" and (self.scenario.startswith("creation") or self.scenario.startswith("case_")):
                data = copy.deepcopy(request.post_data_json)
                self.creations.append(data)
                if self.scenario == "creation_before_commit" and len(self.creations) == 1:
                    route.abort("connectionfailed")
                    return
                if data["id"] in self.created_documents:
                    self.fulfill(route, {"code": "23505", "message": "Fictional primary key conflict"}, 409)
                    return
                created = {**copy.deepcopy(self.document), **data, "qr_token": "99999999-9999-4999-8999-999999999999"}
                created["case_files"] = {"number": next(item["number"] for item in self.rows["case_files"] if item["id"] == data["case_file_id"])}
                created["document_types"] = {"name": next(item["name"] for item in self.rows["document_types"] if item["id"] == data["document_type_id"])}
                created["agencies"] = {"name": next(item["name"] for item in self.rows["agencies"] if item["id"] == data["agency_id"])}
                self.created_documents[data["id"]] = created
                self.creation_movements += 1
                if self.scenario == "creation_lost_reply" and len(self.creations) == 1:
                    route.abort("connectionfailed")
                    return
                self.fulfill(route, created, 201)
                return
            if request.method != "GET":
                self.direct_writes.append({"table": table, "method": request.method})
                self.fulfill(route, {"code": "PT422", "message": "Unexpected direct table write in browser test"}, 422)
                return
            query = parse_qs(parsed.query)
            self.reads.append({"table": table, "query": query})
            if self.scenario == "load_delayed" and table == "case_files":
                self.held_load = (route, copy.deepcopy(self.rows[table]))
                return
            if self.scenario == "load_connection" and table == "case_files":
                route.abort("connectionfailed")
                return
            if self.scenario == "load_catalog_error" and table == "agencies":
                self.fulfill(route, {"code": "503", "message": "Fictional catalog failure"}, 503)
                return
            if self.scenario == "load_transient_catalog" and table == "agencies" and sum(read["table"] == "agencies" for read in self.reads) == 1:
                self.fulfill(route, {"code": "503", "message": "Fictional transient catalog failure"}, 503)
                return
            if self.scenario == "load_catalog_null" and table == "agencies":
                self.fulfill(route, None)
                return
            if table == "documents":
                archived = query.get("archived_at", [""])[0]
                if self.scenario == "load_document_error" and archived == "is.null":
                    self.fulfill(route, {"code": "503", "message": "Fictional document failure"}, 503)
                    return
                if self.scenario.startswith("load_schema_") and "lawyer_id" in query.get("select", [""])[0]:
                    self.fulfill(route, {"code": self.scenario.removeprefix("load_schema_"), "message": "Fictional missing optional column"}, 400)
                    return
                if self.scenario == "load_page_failure" and archived == "is.null":
                    if int(query.get("offset", [0])[0]) >= 1000:
                        self.fulfill(route, {"code": "503", "message": "Fictional second page failure"}, 503)
                    else:
                        rows = [{**copy.deepcopy(self.document), "id": f"aaaaaaaa-aaaa-4aaa-8aaa-{index:012d}"} for index in range(1000)]
                        self.fulfill(route, rows)
                    return
                active_rows = [self.document, *self.extra_documents, *self.created_documents.values()]
                rows = copy.deepcopy(self.archived_documents if archived == "not.is.null" else active_rows if archived == "is.null" else [*active_rows, *self.archived_documents])
                if "id" in query:
                    document_id = query["id"][0].removeprefix("eq.")
                    rows = [row for row in rows if row["id"] == document_id]
                if self.scenario == "delayed_scan" and "qr_token" in query:
                    self.held_lookup = (route, rows)
                    return
            elif table == "movements":
                rows = copy.deepcopy(self.movements)
                if query.get("receipt_number") == ["not.is.null"]:
                    rows = [row for row in rows if row.get("receipt_number") is not None]
                if "document_id" in query:
                    identifier = query["document_id"][0].removeprefix("eq.")
                    rows = [row for row in rows if row.get("document_id", row.get("documents", {}).get("id")) == identifier]
            else:
                rows = copy.deepcopy(self.rows.get(table, []))
                if table == "case_files":
                    if "id" in query:
                        if self.scenario == "case_verify_expired":
                            self.fulfill(route, {"code": "PGRST301", "message": "Fictional expired verification"}, 401)
                            return
                        rows = [row for row in rows if row["id"] == query["id"][0].removeprefix("eq.")]
                    if "number" in query:
                        number = query["number"][0].removeprefix("eq.").casefold()
                        rows = [row for row in rows if row["number"].casefold() == number]
                if "name" in query:
                    name = query["name"][0].removeprefix("eq.").casefold()
                    rows = [row for row in rows if row["name"].casefold() == name]
            if "application/vnd.pgrst.object+json" in request.headers.get("accept", ""):
                self.fulfill(route, rows[0] if rows else None)
            else:
                self.fulfill(route, rows)
            return
        self.fulfill(route, {"message": "Unexpected fixture path"}, 404)

    def auth_payload(self, lifetime=3600):
        now = int(time.time())
        user = {"id": USER_ID, "aud": "authenticated", "role": "authenticated", "email": "prueba@example.invalid", "app_metadata": {}, "user_metadata": {}}
        token = ".".join([
            jwt_part({"alg": "HS256", "typ": "JWT"}),
            jwt_part({"sub": USER_ID, "aud": "authenticated", "role": "authenticated", "exp": now + lifetime, "iat": now + min(lifetime, 0)}),
            "fictional-test-signature",
        ])
        return {"access_token": token, "token_type": "bearer", "expires_in": lifetime, "expires_at": now + lifetime, "refresh_token": "fictional-refresh-token", "user": user}

    def respond_auth(self, route, path):
        payload = self.auth_payload()
        self.fulfill(route, payload if path.endswith("/token") else payload["user"])

    def release_auth(self):
        route = self.held_auth
        self.held_auth = None
        self.respond_auth(route, "/auth/v1/token")

    def release_load(self, rows=None):
        route, original = self.held_load
        self.held_load = None
        self.fulfill(route, original if rows is None else rows)

    def respond_case_creation(self, route, data):
        if self.scenario == "case_before_commit" and len(self.case_creations) == 1:
            route.abort("connectionfailed")
            return
        if self.scenario == "case_rollback" and len(self.case_creations) == 1:
            self.fulfill(route, {"code": "23514", "message": "Fictional constraint failure"}, 400)
            return
        if any(row["id"] == data["id"] or row["number"].casefold() == data["number"].casefold() for row in self.rows["case_files"]):
            self.fulfill(route, {"code": "23505", "message": "Fictional existing case"}, 409)
            return
        self.rows["case_files"].append(copy.deepcopy(data))
        if self.scenario in {"case_lost_reply", "case_verify_expired"} and len(self.case_creations) == 1:
            route.abort("connectionfailed")
            return
        self.fulfill(route, data, 201)

    def release_case(self):
        route, data = self.held_case
        self.held_case = None
        self.respond_case_creation(route, data)

    def respond_operation(self, route, args):
        if self.scenario == "conflict" and len(self.operations) == 1:
            self.document.update(status="RECHAZADO", label="Cambio de otra computadora", last_movement_at="2026-11-09T12:00:00.333333+00:00")
            self.fulfill(route, {"code": "PT409", "message": "El documento cambió desde que lo consultaste."}, 409)
            return
        if self.scenario == "lost_then_expired" and len(self.operations) == 2:
            self.fulfill(route, {"code": "PGRST301", "message": "Fixture session expired during verification"}, 401)
            return
        operation_id = args["p_operation_id"]
        duplicate = operation_id in self.receipts
        if duplicate:
            if self.receipts[operation_id] != args:
                self.fulfill(route, {"code": "PT409", "message": "Identificador reutilizado."}, 409)
                return
        else:
            self.receipts[operation_id] = copy.deepcopy(args)
            if args.get("p_change_label"):
                self.document["label"] = args.get("p_label")
            status = args.get("p_requested_status")
            if status:
                self.tick += 1
                self.document.update(status=status, last_movement_at=f"2026-11-09T11:00:0{self.tick}.654321+00:00")
                self.movements.append({"id": self.tick, "status": status, "occurred_at": self.document["last_movement_at"], "receipt_number": args.get("p_receipt_number"), "documents": copy.deepcopy(self.document)})
        if self.scenario in {"lost_response", "lost_then_expired"} and len(self.operations) == 1:
            route.abort("connectionfailed")
            return
        data = {
            "document": {key: self.document[key] for key in ["id", "status", "last_movement_at", "label", "archived_at"]},
            "recorded_status": args.get("p_requested_status"),
            "duplicate": duplicate,
        }
        self.fulfill(route, data)

    def respond_deletion(self, route, args):
        if self.scenario in {"deletion_missing", "deletion_conflict"}:
            conflict = self.scenario == "deletion_conflict"
            self.fulfill(route, {"code": "PT409" if conflict else "PGRST202", "message": "Fictional deletion unavailable"}, 409 if conflict else 404)
            return
        if self.scenario == "deletion_expired" and len(self.deletions) == 2:
            self.fulfill(route, {"code": "PGRST301", "message": "Fictional verification session expired"}, 401)
            return
        operation_id = args["p_operation_id"]
        duplicate = operation_id in self.deletion_receipts
        if not duplicate:
            self.deletion_receipts[operation_id] = copy.deepcopy(args)
            self.archived_documents = [row for row in self.archived_documents if row['id'] != args['p_document_id']]
        if self.scenario in {"deletion_lost", "deletion_expired"} and len(self.deletions) == 1:
            route.abort("connectionfailed")
            return
        self.fulfill(route, {"document_id": args['p_document_id'], "operation_id": operation_id, "deleted": True, "duplicate": duplicate})

    def release_lookup(self):
        route, rows = self.held_lookup
        self.held_lookup = None
        if "application/vnd.pgrst.object+json" in route.request.headers.get("accept", ""):
            self.fulfill(route, rows[0])
        else:
            self.fulfill(route, rows)

    def release_operation(self):
        route, args = self.held_operation
        self.held_operation = None
        self.respond_operation(route, args)


class BrowserOperations(unittest.TestCase):
    base_url = None
    browser = None

    def open_login(self, scenario, configure=None, expired_session=False, timezone_id="UTC", context_options=None):
        context = self.browser.new_context(timezone_id=timezone_id, **(context_options or {}))
        self.addCleanup(context.close)
        fixture = SupabaseFixture(self.base_url, scenario)
        if configure:
            configure(fixture)
        if expired_session:
            context.add_cookies([{"name": "sb-operation-test-auth-token", "value": "base64-" + jwt_part(fixture.auth_payload(lifetime=-3600)), "url": self.base_url}])
        context.route("**/*", fixture.route)
        page = context.new_page()
        page.set_default_timeout(10000)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        def handle_dialog(dialog):
            fixture.dialog_types.append(dialog.type)
            dialog.dismiss() if dialog.type == "beforeunload" else dialog.accept()
        page.on("dialog", handle_dialog)
        page.goto(self.base_url, wait_until="domcontentloaded")
        self.addCleanup(lambda: self.assertEqual(errors, [], "Browser runtime errors"))
        self.addCleanup(lambda: self.assertEqual(fixture.unexpected_hosts, [], "An unexpected external destination was blocked"))
        self.addCleanup(lambda: self.assertEqual(fixture.direct_writes, [], "UI must use the atomic RPC"))
        return page, fixture

    def open_app(self, scenario, configure=None, timezone_id="UTC", context_options=None):
        page, fixture = self.open_login(scenario, configure, timezone_id=timezone_id, context_options=context_options)
        page.get_by_label("Usuario o correo").fill("prueba")
        page.get_by_label("Contraseña", exact=True).fill("fictional-test-password")
        page.get_by_role("button", name="Ingresar", exact=True).click()
        expect(page.locator(".workspace-app")).to_be_visible()
        expect(page.get_by_text("prueba", exact=True).first).to_be_visible()
        return page, fixture

    def failed_login_then_retry(self, scenario, expected):
        page, fixture = self.open_login(scenario)
        page.get_by_label("Usuario o correo").fill("prueba")
        page.get_by_label("Contraseña", exact=True).fill("fictional-test-password")
        login = page.get_by_role("button", name="Ingresar", exact=True)
        login.click()
        expect(page.get_by_role("status")).to_contain_text(expected)
        expect(login).to_be_enabled()
        expect(page.get_by_label("Usuario o correo")).to_have_value("prueba")
        expect(page.get_by_label("Contraseña", exact=True)).to_have_value("fictional-test-password")
        if scenario != "auth_credentials":
            self.assertNotIn("contraseña incorrectos", page.get_by_role("status").inner_text())
        fixture.scenario = "normal"
        page.get_by_label("Contraseña", exact=True).fill("fictional-corrected-password")
        login.click()
        expect(page.get_by_role("navigation", name="Menú principal")).to_be_visible()
        self.assertGreaterEqual(len(fixture.auth_attempts), 2)
        return page, fixture

    def visual_navigate(self, page, label):
        toggle = page.get_by_role("button", name="Abrir menú de navegación", exact=True)
        if toggle.is_visible() and toggle.get_attribute("aria-expanded") == "false":
            toggle.click()
        page.get_by_role("navigation", name="Menú principal").get_by_role("button", name=label, exact=True).click()
        if toggle.is_visible():
            expect(page.get_by_role("navigation", name="Menú principal")).not_to_be_visible()

    @staticmethod
    def visual_fixture(fixture):
        for index, status in [(2, "AUTORIZADO"), (3, "ENVIADO")]:
            document = copy.deepcopy(fixture.document)
            document.update(id=f"aaaaaaaa-aaaa-4aaa-8aaa-{index:012d}", status=status, last_movement_at="2026-01-02T12:00:00+00:00")
            document["case_files"] = {"number": f"TEST-{index:03d}"}
            fixture.extra_documents.append(document)

    @staticmethod
    def deletion_fixture(fixture):
        target = copy.deepcopy(fixture.document)
        target.update(id="dddddddd-dddd-4ddd-8ddd-dddddddddddd", label="Archivo a eliminar", archived_at="2026-11-13T02:00:00.123456Z")
        fixture.archived_documents = [target]

    def open_deletion(self, page):
        self.visual_navigate(page, 'Archivados')
        page.get_by_role('button', name='Eliminar definitivamente', exact=True).click()
        return page.get_by_role('dialog', name='Eliminar documento', exact=True)

    def test_deletion_requires_explicit_confirmation_and_cancel_or_escape_send_nothing(self):
        page, fixture = self.open_app('deletion_normal', configure=self.deletion_fixture)
        dialog = self.open_deletion(page)
        expect(dialog).to_contain_text('TEST-001')
        expect(dialog).to_contain_text('CERTIFICADO — Archivo a eliminar')
        expect(dialog).to_contain_text('El expediente y sus otros documentos se conservarán')
        submit = dialog.get_by_role('button', name='Eliminar definitivamente', exact=True)
        expect(submit).to_be_disabled()
        page.keyboard.press('Shift+Tab')
        expect(dialog.get_by_role('button', name='Cancelar', exact=True)).to_be_focused()
        page.keyboard.press('Tab')
        expect(dialog.get_by_role('button', name='Cerrar confirmación', exact=True)).to_be_focused()
        dialog.get_by_label('Escribe ELIMINAR para confirmar').fill('eliminar')
        expect(submit).to_be_disabled()
        dialog.get_by_role('button', name='Cancelar', exact=True).click()
        expect(dialog).not_to_be_visible()
        dialog = self.open_deletion(page)
        page.keyboard.press('Escape')
        expect(dialog).not_to_be_visible()
        self.assertEqual(fixture.deletions, [])

    def test_deletion_confirms_once_and_preserves_other_documents_and_case(self):
        page, fixture = self.open_app('deletion_normal', configure=self.deletion_fixture)
        dialog = self.open_deletion(page)
        dialog.get_by_label('Escribe ELIMINAR para confirmar').fill('ELIMINAR')
        dialog.get_by_role('button', name='Eliminar definitivamente', exact=True).click()
        expect(dialog).not_to_be_visible()
        expect(page.get_by_role('status')).to_contain_text('eliminado definitivamente junto con su historial')
        expect(page.locator('.archived-section')).to_contain_text('No hay documentos archivados')
        self.assertEqual(len(fixture.deletions), 1)
        self.assertEqual(fixture.deletions[0]['p_expected_archived_at'], '2026-11-13T02:00:00.123456Z')
        self.visual_navigate(page, 'Buscar')
        expect(page.locator('.documents-list')).to_contain_text('Original')
        self.visual_navigate(page, 'Alta')
        expect(page.locator('datalist option[value="TEST-001"]')).to_have_count(1)

    def test_deletion_double_click_waits_for_one_rpc_and_protects_reload(self):
        page, fixture = self.open_app('deletion_delayed', configure=self.deletion_fixture)
        dialog = self.open_deletion(page)
        dialog.get_by_label('Escribe ELIMINAR para confirmar').fill('ELIMINAR')
        dialog.get_by_role('button', name='Eliminar definitivamente', exact=True).evaluate('button=>{button.click();button.click();}')
        expect(dialog.get_by_role('button', name='Cancelar', exact=True)).to_be_disabled()
        expect(dialog.get_by_label('Escribe ELIMINAR para confirmar')).to_be_disabled()
        page.wait_for_function("()=>document.querySelector('.deletion-modal button[type=submit]')?.disabled===true")
        page.evaluate('()=>window.location.reload()')
        deadline = time.monotonic() + 5
        while 'beforeunload' not in fixture.dialog_types and time.monotonic() < deadline:
            page.wait_for_timeout(20)
        self.assertIn('beforeunload', fixture.dialog_types)
        self.assertEqual(len(fixture.deletions), 1)
        self.assertIsNotNone(fixture.held_deletion)
        route, args = fixture.held_deletion
        fixture.respond_deletion(route, args)
        expect(dialog).not_to_be_visible()

    def test_deletion_lost_reply_and_expired_verification_preserve_identity(self):
        page, fixture = self.open_app('deletion_expired', configure=self.deletion_fixture)
        dialog = self.open_deletion(page)
        dialog.get_by_label('Escribe ELIMINAR para confirmar').fill('ELIMINAR')
        dialog.get_by_role('button', name='Eliminar definitivamente', exact=True).click()
        verify = dialog.get_by_role('button', name='Verificar eliminación', exact=True)
        expect(verify).to_be_enabled()
        expect(dialog.get_by_role('status')).to_contain_text('podría haberse eliminado')
        page.keyboard.press('Tab')
        expect(verify).to_be_focused()
        page.keyboard.press('Escape')
        expect(dialog).to_be_visible()
        verify.click()
        expect(verify).to_be_enabled()
        expect(dialog.get_by_role('button', name='Cancelar', exact=True)).to_be_disabled()
        verify.click()
        expect(dialog).not_to_be_visible()
        self.assertEqual(len(fixture.deletion_receipts), 1)
        self.assertEqual(len(fixture.deletions), 3)
        for request in fixture.deletions:
            self.assertEqual(request, fixture.deletions[0])

    def test_deletion_missing_rpc_and_conflict_are_not_reported_as_success(self):
        for scenario in ['deletion_missing', 'deletion_conflict']:
            with self.subTest(scenario=scenario):
                page, fixture = self.open_app(scenario, configure=self.deletion_fixture)
                dialog = self.open_deletion(page)
                dialog.get_by_label('Escribe ELIMINAR para confirmar').fill('ELIMINAR')
                dialog.get_by_role('button', name='Eliminar definitivamente', exact=True).click()
                if scenario == 'deletion_missing':
                    expect(dialog.get_by_role('status')).to_contain_text('No se eliminó el documento')
                    expect(dialog.get_by_role('button', name='Cancelar', exact=True)).to_be_enabled()
                else:
                    expect(dialog).not_to_be_visible()
                    expect(page.get_by_role('status')).to_contain_text('No se realizó esta eliminación')
                self.assertEqual(len(fixture.archived_documents), 1)

    def test_deletion_button_respects_existing_roles_and_mobile_dialog_fits(self):
        for role in ['admin', 'supervisor', 'empleado', 'consulta']:
            with self.subTest(role=role):
                def configure(fixture):
                    self.deletion_fixture(fixture)
                    fixture.rows['profiles'][0]['role'] = role
                page, fixture = self.open_app('deletion_normal', configure=configure, context_options={'viewport': {'width': 390, 'height': 844}, 'is_mobile': True, 'has_touch': True})
                self.visual_navigate(page, 'Archivados')
                button = page.get_by_role('button', name='Eliminar definitivamente', exact=True)
                if role in ['admin', 'supervisor']:
                    button.click()
                    dialog = page.get_by_role('dialog', name='Eliminar documento', exact=True)
                    expect(dialog).to_be_visible()
                    self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), 391)
                    box = page.locator('.deletion-modal').bounding_box()
                    self.assertLessEqual(box['width'], 390)
                    page.add_style_tag(content='nextjs-portal { display:none !important; }')
                    page.screenshot(path=f'/tmp/rastreodoc-eliminar-{role}-phone.png', full_page=True, animations='disabled')
                else:
                    expect(button).to_have_count(0)
                self.assertEqual(fixture.deletions, [])

    def test_visual_desktop_all_sections_keep_real_indicators_and_controls(self):
        page, fixture = self.open_app("normal", configure=self.visual_fixture, context_options={"viewport": {"width": 1774, "height": 1000}, "locale": "es-MX"})
        page.add_style_tag(content="nextjs-portal { display:none !important; }")
        expect(page.locator(".summary-value")).to_have_text(["3", "1", "1"])
        expect(page.locator(".notification-count")).to_have_text("1")
        expect(page.locator(".brand-mark")).to_have_count(1)
        sections = {
            "Panel": ("panel", ".dashboard-view"), "Alta": ("alta", ".workspace-grid"),
            "Boletas": ("boletas", ".receipt-section"), "Escanear": ("escanear", ".scanner-section"),
            "Buscar": ("buscar", ".documents-section"), "Reportes": ("reportes", ".reports-section"),
            "Archivados": ("archivados", ".archived-section"), "Catálogos": ("catalogos", ".catalogs-section"),
            "Usuarios": ("usuarios", ".users-section"),
        }
        for label, (slug, selector) in sections.items():
            self.visual_navigate(page, label)
            expect(page.locator(selector)).to_be_visible()
            expect(page.get_by_role("navigation", name="Menú principal").get_by_role("button", name=label, exact=True)).to_have_attribute("aria-current", "page")
            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 1775, label)
            page.screenshot(path=f"/tmp/rastreodoc-rediseno-{slug}-desktop.png", full_page=True, animations="disabled")
        self.assertEqual(fixture.creations, [])
        self.assertEqual(fixture.case_creations, [])
        self.assertEqual(fixture.operations, [])

    def test_visual_phone_and_tablet_navigation_preserve_forms_without_horizontal_overflow(self):
        for name, width, height in [("iphone", 390, 844), ("android", 412, 915), ("tablet", 768, 1024)]:
            with self.subTest(device=name):
                page, fixture = self.open_app("normal", context_options={"viewport": {"width": width, "height": height}, "is_mobile": True, "has_touch": True, "locale": "es-MX"})
                page.add_style_tag(content="nextjs-portal { display:none !important; }")
                toggle = page.get_by_role("button", name="Abrir menú de navegación", exact=True)
                expect(toggle).to_be_visible()
                toggle.click()
                expect(toggle).to_have_attribute("aria-expanded", "true")
                page.keyboard.press("Escape")
                expect(toggle).to_have_attribute("aria-expanded", "false")
                expect(toggle).to_be_focused()
                for label in ["Panel", "Alta", "Boletas", "Escanear", "Buscar", "Reportes", "Archivados", "Catálogos", "Usuarios"]:
                    self.visual_navigate(page, label)
                    expect(toggle).to_have_attribute("aria-expanded", "false")
                    self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width + 1, f"{name}: {label}")
                self.visual_navigate(page, "Alta")
                page.get_by_label("Número de expediente", exact=True).fill("BORRADOR-VISUAL")
                self.visual_navigate(page, "Reportes")
                page.screenshot(path=f"/tmp/rastreodoc-rediseno-reportes-{name}.png", full_page=True, animations="disabled")
                self.visual_navigate(page, "Alta")
                expect(page.get_by_label("Número de expediente", exact=True)).to_have_value("BORRADOR-VISUAL")
                page.screenshot(path=f"/tmp/rastreodoc-rediseno-alta-{name}.png", full_page=True, animations="disabled")
                self.assertEqual(fixture.creations, [])
                self.assertEqual(fixture.case_creations, [])

    def test_visual_navigation_keeps_the_existing_role_options(self):
        common = ["Panel", "Alta", "Boletas", "Escanear", "Buscar", "Reportes", "Archivados"]
        for role, expected in [("admin", [*common, "Catálogos", "Usuarios"]), ("supervisor", [*common, "Catálogos", "Usuarios"]), ("empleado", common), ("consulta", ["Panel", "Buscar", "Reportes", "Archivados"])]:
            with self.subTest(role=role):
                def profile(fixture):
                    fixture.rows["profiles"][0]["role"] = role
                page, _ = self.open_app("normal", configure=profile)
                for navigation in ["Menú principal", "Accesos de sección"]:
                    expect(page.get_by_role("navigation", name=navigation).get_by_role("button")).to_have_text(expected)

    def test_visual_top_search_reuses_the_existing_filter_and_preserves_it_between_views(self):
        page, fixture = self.open_app("normal")
        initial_reads = len(fixture.reads)
        search = page.get_by_label("Buscar documentos", exact=True)
        expect(search).to_be_disabled()
        self.visual_navigate(page, "Buscar")
        expect(search).to_be_enabled()
        search.fill("NO-HAY")
        expect(page.get_by_text("No hay documentos que coincidan con la búsqueda.", exact=True)).to_be_visible()
        self.visual_navigate(page, "Reportes")
        expect(search).to_be_disabled()
        self.visual_navigate(page, "Buscar")
        expect(search).to_have_value("NO-HAY")
        search.fill("")
        expect(page.locator(".document-row")).to_have_count(1)
        self.assertEqual(len(fixture.reads), initial_reads)

    def start_data_load(self, page):
        page.get_by_label("Usuario o correo").fill("prueba")
        page.get_by_label("Contraseña", exact=True).fill("fictional-test-password")
        page.get_by_role("button", name="Ingresar", exact=True).click()

    def assert_loaded_document(self, page):
        navigation = page.get_by_role("navigation", name="Menú principal")
        expect(navigation).to_be_visible()
        navigation.get_by_role("button", name="Buscar", exact=True).click()
        expect(page.locator(".document-row")).to_have_count(1)
        expect(page.locator(".document-row")).to_contain_text("TEST-001 · CERTIFICADO — Original")

    def test_loading_waits_for_the_last_query_before_showing_counts_or_capture(self):
        page, fixture = self.open_login("load_delayed")
        self.start_data_load(page)
        expect(page.get_by_role("heading", name="Cargando información…", exact=True)).to_be_visible()
        expect(page.get_by_role("navigation", name="Menú principal")).not_to_be_visible()
        expect(page.locator(".dashboard-cards, .reports-section, .case-panel")).to_have_count(0)
        self.assertEqual(fixture.creations, [])
        self.assertEqual(fixture.operations, [])
        deadline = time.monotonic() + 5
        while fixture.held_load is None and time.monotonic() < deadline:
            page.wait_for_timeout(20)
        self.assertIsNotNone(fixture.held_load)
        fixture.release_load()
        self.assert_loaded_document(page)

    def test_loading_failed_network_catalog_or_null_response_requires_retry(self):
        for scenario in ["load_connection", "load_catalog_error", "load_catalog_null"]:
            with self.subTest(scenario=scenario):
                page, fixture = self.open_login(scenario)
                self.start_data_load(page)
                panel = page.locator(".data-load-panel")
                # The SDK retries idempotent reads after 1s, 2s and 4s. Allow
                # those real retries, without disabling production behavior.
                expect(panel.get_by_role("alert")).to_have_text("No se pudo cargar la información completa. Revisa tu conexión y pulsa Reintentar carga.", timeout=12000)
                expect(page.get_by_role("navigation", name="Menú principal")).not_to_be_visible()
                expect(page.locator(".dashboard-cards, .reports-section, .case-panel")).to_have_count(0)
                fixture.scenario = "normal"
                page.get_by_role("button", name="Reintentar carga", exact=True).click()
                self.assert_loaded_document(page)
                self.assertEqual(fixture.creations, [])
                self.assertEqual(fixture.operations, [])

    def test_loading_document_service_failure_does_not_retry_a_reduced_selection(self):
        page, fixture = self.open_login("load_document_error")
        self.start_data_load(page)
        expect(page.locator(".data-load-panel").get_by_role("alert")).to_be_visible(timeout=12000)
        document_reads = [read for read in fixture.reads if read["table"] == "documents"]
        self.assertTrue(document_reads)
        self.assertTrue(all("lawyer_id" in read["query"]["select"][0] for read in document_reads))
        fixture.scenario = "normal"
        page.get_by_role("button", name="Reintentar carga", exact=True).click()
        self.assert_loaded_document(page)

    def test_loading_failure_on_second_page_never_publishes_the_first_thousand_rows(self):
        page, fixture = self.open_login("load_page_failure")
        self.start_data_load(page)
        expect(page.locator(".data-load-panel").get_by_role("alert")).to_be_visible(timeout=12000)
        expect(page.locator(".document-row, .dashboard-cards, .reports-section")).to_have_count(0)
        document_reads = [read for read in fixture.reads if read["table"] == "documents"]
        self.assertTrue(any(read["query"].get("offset") == ["1000"] for read in document_reads))
        self.assertTrue(all("lawyer_id" in read["query"]["select"][0] for read in document_reads))
        fixture.scenario = "normal"
        page.get_by_role("button", name="Reintentar carga", exact=True).click()
        self.assert_loaded_document(page)

    def test_loading_timeout_recovers_and_ignores_a_late_old_response(self):
        page, fixture = self.open_login("load_delayed")
        page.clock.install()
        self.start_data_load(page)
        expect(page.get_by_role("heading", name="Cargando información…", exact=True)).to_be_visible()
        page.wait_for_function("()=>document.querySelector('.data-load-panel')?.getAttribute('aria-busy')==='true'")
        page.clock.fast_forward(21000)
        expect(page.locator(".data-load-panel").get_by_role("alert")).to_contain_text("La carga está tardando más de lo esperado.")
        self.assertIsNotNone(fixture.held_load)
        fixture.scenario = "normal"
        page.get_by_role("button", name="Reintentar carga", exact=True).click()
        self.assert_loaded_document(page)
        fixture.release_load([{"id": CASE_ID, "number": "OBSOLETE-CASE"}])
        page.get_by_role("navigation", name="Menú principal").get_by_role("button", name="Alta", exact=True).click()
        expect(page.locator('datalist option[value="TEST-001"]')).to_have_count(1)
        expect(page.locator('datalist option[value="OBSOLETE-CASE"]')).to_have_count(0)

    def test_loading_logout_cancels_the_old_read_before_a_new_login(self):
        page, fixture = self.open_login("load_delayed")
        self.start_data_load(page)
        expect(page.get_by_role("heading", name="Cargando información…", exact=True)).to_be_visible()
        page.get_by_role("button", name="Cerrar sesión", exact=True).click()
        expect(page.get_by_role("button", name="Ingresar", exact=True)).to_be_visible()
        fixture.scenario = "normal"
        self.start_data_load(page)
        self.assert_loaded_document(page)
        fixture.release_load([{"id": CASE_ID, "number": "OBSOLETE-CASE"}])
        self.assert_loaded_document(page)

    def test_loading_still_supports_missing_optional_columns(self):
        for code in ["42703", "PGRST204"]:
            with self.subTest(code=code):
                page, fixture = self.open_app(f"load_schema_{code}")
                self.assert_loaded_document(page)
                document_reads = [read for read in fixture.reads if read["table"] == "documents"]
                self.assertTrue(any("lawyer_id" not in read["query"]["select"][0] for read in document_reads))

    def test_loading_recovers_a_transient_service_error_with_the_sdk_retry(self):
        page, fixture = self.open_app("load_transient_catalog")
        self.assert_loaded_document(page)
        self.assertEqual(len([read for read in fixture.reads if read["table"] == "agencies"]), 2)
        expect(page.get_by_role("button", name="Reintentar carga", exact=True)).not_to_be_visible()
        self.assertEqual(len(fixture.auth_attempts), 1)

    def test_auth_incorrect_password_is_specific_and_success_clears_the_password(self):
        page, _ = self.failed_login_then_retry("auth_credentials", "Usuario o contraseña incorrectos")
        page.get_by_role("button", name="Cerrar sesión", exact=True).click()
        expect(page.get_by_label("Contraseña", exact=True)).to_have_value("")
        expect(page.get_by_role("button", name="Ingresar", exact=True)).to_be_enabled()

    def test_auth_network_failure_is_not_reported_as_an_incorrect_password(self):
        self.failed_login_then_retry("auth_connection", "problema de conexión")

    def test_auth_service_failure_has_a_service_message_and_releases_the_button(self):
        self.failed_login_then_retry("auth_service", "servicio de acceso no está disponible")

    def test_auth_rate_limit_explains_waiting_and_allows_a_later_retry(self):
        self.failed_login_then_retry("auth_rate", "Espera unos minutos")

    def test_auth_unconfirmed_account_has_a_specific_message(self):
        self.failed_login_then_retry("auth_unconfirmed", "cuenta necesita confirmar el correo")

    def test_auth_double_submission_has_one_request_and_keeps_fields_locked_until_done(self):
        page, fixture = self.open_login("auth_delayed")
        page.get_by_label("Usuario o correo").fill("prueba")
        page.get_by_label("Contraseña", exact=True).fill("fictional-test-password")
        page.get_by_role("button", name="Ingresar", exact=True).evaluate("button=>{button.click();button.click();}")
        expect(page.get_by_role("button", name="Ingresando…", exact=True)).to_be_disabled()
        expect(page.get_by_label("Usuario o correo")).to_be_disabled()
        expect(page.get_by_label("Contraseña", exact=True)).to_be_disabled()
        deadline = time.monotonic() + 5
        while fixture.held_auth is None and time.monotonic() < deadline:
            page.wait_for_timeout(20)
        self.assertIsNotNone(fixture.held_auth)
        self.assertEqual(len(fixture.auth_attempts), 1)
        fixture.release_auth()
        expect(page.get_by_role("navigation", name="Menú principal")).to_be_visible()
        self.assertEqual(len(fixture.auth_attempts), 1)

    def test_auth_saved_session_service_failure_exposes_recovery_and_recovers_without_password(self):
        page, fixture = self.open_login("auth_service", expired_session=True)
        retry = page.get_by_role("button", name="Reintentar sesión", exact=True)
        expect(retry).to_be_visible(timeout=24000)
        expect(retry).to_be_enabled()
        self.assertGreater(len(fixture.auth_attempts), 0)
        fixture.scenario = "normal"
        retry.click()
        expect(page.get_by_role("navigation", name="Menú principal")).to_be_visible(timeout=15000)

    @staticmethod
    def office_date_fixture(fixture):
        fixture.document.update(label="Antes de medianoche", last_movement_at="2026-11-12T05:30:00.123456+00:00", created_at="2026-11-12T05:30:00.123456+00:00")
        fixture.document["case_files"] = {"number": "FECHA-A"}
        second = copy.deepcopy(fixture.document)
        second.update(id="aaaaaaaa-aaaa-4aaa-8aaa-000000000002", qr_token="bbbbbbbb-bbbb-4bbb-8bbb-000000000002", label="Después de medianoche", last_movement_at="2026-11-12T06:30:00.654321+00:00", created_at="2026-11-12T06:30:00.654321+00:00")
        second["case_files"] = {"number": "FECHA-B"}
        fixture.extra_documents.append(second)
        fixture.rows["case_files"] = [{"id": CASE_ID, "number": "FECHA-A"}, {"id": "cccccccc-cccc-4ccc-8ccc-000000000002", "number": "FECHA-B"}]
        fixture.movements = [{"id": 1, "document_id": DOC_ID, "status": "EN_OFICINA", "occurred_at": fixture.document["last_movement_at"], "receipt_number": None, "rejection_reason": None, "notes": None}]

    def open_report(self, page):
        page.get_by_role("navigation", name="Menú principal").get_by_role("button", name="Reportes", exact=True).click()
        expect(page.get_by_text("Fechas y horas de la Ciudad de México.", exact=True)).to_be_visible()

    def test_report_days_follow_mexico_midnight_in_utc_and_other_computer_zones(self):
        for zone in ["UTC", "America/Los_Angeles"]:
            with self.subTest(timezone=zone):
                page, _ = self.open_app("normal", configure=self.office_date_fixture, timezone_id=zone)
                self.open_report(page)
                start = page.get_by_label("Desde", exact=True)
                end = page.get_by_label("Hasta", exact=True)
                rows = page.locator(".report-table tbody tr")
                start.fill("2026-11-11")
                end.fill("2026-11-11")
                expect(rows).to_have_count(1)
                expect(rows).to_contain_text("FECHA-A")
                expect(rows.locator("td").first).to_have_text(re.compile(r"11/11/2026.*23:30:00"))
                start.fill("2026-11-12")
                end.fill("2026-11-12")
                expect(rows).to_have_count(1)
                expect(rows).to_contain_text("FECHA-B")
                expect(rows.locator("td").first).to_have_text(re.compile(r"12/11/2026.*00:30:00"))
                start.fill("")
                end.fill("2026-11-11")
                expect(rows).to_contain_text("FECHA-A")
                end.fill("")
                start.fill("2026-11-12")
                expect(rows).to_contain_text("FECHA-B")
                start.fill("")
                expect(rows).to_have_count(2)

    def test_report_excel_pdf_and_print_share_the_filtered_office_date(self):
        page, _ = self.open_app("normal", configure=self.office_date_fixture)
        self.open_report(page)
        page.get_by_label("Desde", exact=True).fill("2026-11-11")
        page.get_by_label("Hasta", exact=True).fill("2026-11-11")
        # Freeze Date without stopping browser timers: the filename must use the
        # office day even though UTC is already the next day.
        page.clock.set_fixed_time(datetime(2026, 11, 12, 5, 30, tzinfo=timezone.utc))
        with page.expect_download() as downloaded:
            page.get_by_role("button", name="Exportar a Excel", exact=True).click()
        download = downloaded.value
        self.assertEqual(download.suggested_filename, "reporte-rastreadoc-2026-11-11.csv")
        records = list(csv.reader(StringIO(Path(download.path()).read_text(encoding="utf-8-sig"))))
        self.assertEqual(len(records), 2)
        self.assertEqual(len(records[1]), 14)
        self.assertEqual(records[1][2], "FECHA-A")
        self.assertRegex(records[1][0], r"11/11/2026.*23:30:00")
        with page.expect_popup() as viewed:
            page.get_by_role("button", name="Ver PDF", exact=True).click()
        popup = viewed.value
        expect(popup.locator("tbody tr")).to_have_count(1)
        expect(popup.locator("tbody tr td").first).to_have_text(records[1][0])
        expect(popup.get_by_text("Fechas y horas de la Ciudad de México.", exact=True)).to_be_visible()
        self.spy_print(page)
        with page.expect_popup() as printed:
            page.get_by_role("button", name="Imprimir", exact=True).click()
        printing = printed.value
        printing.wait_for_function("()=>window.__printCalls?.length===1")
        expect(printing.locator("tbody tr")).to_have_count(1)
        expect(printing.locator("tbody tr td").first).to_have_text(records[1][0])

    def test_report_inverted_dates_show_a_message_and_disable_exports_until_corrected(self):
        page, _ = self.open_app("normal", configure=self.office_date_fixture)
        self.open_report(page)
        report = page.locator(".reports-section")
        page.get_by_label("Desde", exact=True).fill("2026-11-12")
        page.get_by_label("Hasta", exact=True).fill("2026-11-11")
        expect(report.get_by_role("alert")).to_have_text("La fecha Desde no puede ser posterior a Hasta.")
        for action in ["Imprimir", "Exportar a Excel", "Ver PDF"]:
            expect(page.get_by_role("button", name=action, exact=True)).to_be_disabled()
        expect(page.locator(".reports-heading strong")).to_have_text("Revisa las fechas")
        page.get_by_label("Hasta", exact=True).fill("2026-11-12")
        expect(report.get_by_role("alert")).not_to_be_visible()
        for action in ["Imprimir", "Exportar a Excel", "Ver PDF"]:
            expect(page.get_by_role("button", name=action, exact=True)).to_be_enabled()
        expect(page.locator(".report-table tbody tr")).to_contain_text("FECHA-B")

    def test_history_and_case_details_use_the_same_office_time_as_reports(self):
        page, _ = self.open_app("normal", configure=self.office_date_fixture)
        page.get_by_role("navigation", name="Menú principal").get_by_role("button", name="Buscar", exact=True).click()
        before_midnight = page.locator(".document-row").filter(has_text="FECHA-A")
        before_midnight.get_by_role("button", name="Ver expediente", exact=True).click()
        case = page.get_by_role("dialog", name="Expediente FECHA-A", exact=True)
        expect(case.locator(".case-document-date strong")).to_have_text(re.compile(r"11/11/2026.*23:30:00"))
        case.get_by_role("button", name="Historial", exact=True).click()
        history = page.get_by_role("dialog", name="Historial del documento", exact=True)
        expect(history.locator(".timeline li")).to_have_count(1)
        expect(history.locator(".timeline li span")).to_have_text(re.compile(r"11/11/2026.*23:30:00"))

    def test_capture_and_saving_do_not_format_all_report_dates_until_reports_open(self):
        page, _ = self.open_app("creation_normal")
        page.evaluate("""()=>{
          window.__officeDateFormats=0;
          const original=Intl.DateTimeFormat.prototype.formatToParts;
          Intl.DateTimeFormat.prototype.formatToParts=function(...args){
            if(this.resolvedOptions().timeZone==='America/Mexico_City') window.__officeDateFormats++;
            return original.apply(this,args);
          };
        }""")
        self.alta(page)
        page.get_by_role("button", name="Agregar documento", exact=True).click()
        expect(page.get_by_role("region", name="Último documento guardado")).to_be_visible()
        self.assertEqual(page.evaluate("window.__officeDateFormats"), 0, "Capturing and saving must not format every report row")
        self.open_report(page)
        expect(page.locator(".report-table tbody tr")).to_have_count(2)
        self.assertGreater(page.evaluate("window.__officeDateFormats"), 0)

    def boletas(self, page):
        page.get_by_role("navigation", name="Menú principal").get_by_role("button", name="Boletas", exact=True).click()
        expect(page.get_by_text("TEST-001 · CERTIFICADO — Original", exact=True)).to_be_visible()
        page.get_by_label("Número de boleta", exact=True).fill("B-TEST-123")

    def alta(self, page):
        page.get_by_role("navigation", name="Menú principal").get_by_role("button", name="Alta", exact=True).click()
        page.get_by_label("Buscar expediente", exact=True).fill("TEST-001")
        page.get_by_label("Tipo de documento").select_option("CERTIFICADO")
        page.get_by_label("Abogado").select_option(LAWYER_ID)
        page.get_by_label("Auxiliar").select_option(AUXILIARY_ID)
        page.get_by_label("Identificador para distinguirlo (opcional)").fill("Nuevo de prueba")

    def spy_print(self, page, broken_image=False):
        page.context.add_init_script("""
window.__printCalls=[];
window.print=()=>window.__printCalls.push({
  labels:document.querySelectorAll('.label').length,
  allDecoded:Array.from(document.images).every(image=>image.complete && image.naturalWidth===420)
});
""" + ("HTMLImageElement.prototype.decode=()=>Promise.reject(new Error('Fictional image decode failure'));" if broken_image else ""))

    def assert_label_pdf(self, popup, count, path):
        pdf = PdfReader(BytesIO(popup.pdf(path=path, prefer_css_page_size=True)))
        self.assertEqual(len(pdf.pages), count, "Print exactly one page per selected label")
        for page in pdf.pages:
            self.assertAlmostEqual(float(page.mediabox.width) * 25.4 / 72, 40, delta=0.5)
            self.assertAlmostEqual(float(page.mediabox.height) * 25.4 / 72, 30, delta=0.5)

    def case_form(self, page, number="EX-NUEVO"):
        page.get_by_role("navigation", name="Menú principal").get_by_role("button", name="Alta", exact=True).click()
        page.get_by_label("Número de expediente", exact=True).fill(number)
        return page.get_by_role("button", name="Guardar expediente", exact=True)

    def assert_case_selected(self, page, number="EX-NUEVO"):
        expect(page.get_by_label("Buscar expediente", exact=True)).to_have_value(number)
        expect(page.get_by_label("Número de expediente", exact=True)).to_have_value("")
        expect(page.locator(f'datalist option[value="{number}"]')).to_have_count(1)
        expect(page.get_by_role("button", name="Verificar expediente", exact=True)).not_to_be_visible()

    def test_case_normal_double_click_uses_one_insert_and_immediately_accepts_documents(self):
        page, fixture = self.open_app("case_normal")
        initial_reads = len(fixture.reads)
        self.case_form(page, "  EX-NUEVO  ").evaluate("button=>{button.click();button.click();}")
        expect(page.get_by_role("status")).to_have_text("Expediente EX-NUEVO guardado correctamente.")
        self.assert_case_selected(page)
        self.assertEqual(len(fixture.case_creations), 1)
        self.assertEqual(len(fixture.reads), initial_reads, "Normal case creation must not reload workspace data")
        page.get_by_label("Tipo de documento").select_option("CERTIFICADO")
        page.get_by_label("Abogado").select_option(LAWYER_ID)
        page.get_by_label("Auxiliar").select_option(AUXILIARY_ID)
        page.get_by_label("Identificador para distinguirlo (opcional)").fill("Documento nuevo expediente")
        page.get_by_role("button", name="Agregar documento", exact=True).click()
        expect(page.get_by_role("region", name="Último documento guardado")).to_contain_text("EX-NUEVO · CERTIFICADO — Documento nuevo expediente")
        self.assertEqual(fixture.creations[0]["case_file_id"], fixture.case_creations[0]["id"])
        self.assertEqual(fixture.creation_movements, 1)

    def test_case_lost_reply_stays_verifiable_after_navigation_and_blocks_reload(self):
        page, fixture = self.open_app("case_lost_reply")
        self.case_form(page).click()
        verify = page.get_by_role("button", name="Verificar expediente", exact=True)
        expect(verify).to_be_enabled()
        expect(page.get_by_role("status")).to_contain_text("Podría haberse guardado")
        expect(page.get_by_label("Número de expediente", exact=True)).to_be_disabled()
        expect(page.get_by_label("Buscar expediente", exact=True)).to_be_disabled()
        page.evaluate("()=>window.location.reload()")
        deadline = time.monotonic() + 5
        while "beforeunload" not in fixture.dialog_types and time.monotonic() < deadline:
            page.wait_for_timeout(20)
        self.assertIn("beforeunload", fixture.dialog_types)
        page.get_by_role("navigation", name="Menú principal").get_by_role("button", name="Reportes", exact=True).click()
        expect(verify).to_be_visible()
        verify.evaluate("button=>{button.click();button.click();}")
        expect(verify).not_to_be_visible()
        page.get_by_role("navigation", name="Menú principal").get_by_role("button", name="Alta", exact=True).click()
        self.assert_case_selected(page)
        self.assertEqual(len(fixture.case_creations), 1)
        self.assertEqual(len([read for read in fixture.reads if read["table"] == "case_files" and "id" in read["query"]]), 1)

    def test_case_precommit_failure_retries_the_original_id_and_number(self):
        page, fixture = self.open_app("case_before_commit")
        self.case_form(page).click()
        verify = page.get_by_role("button", name="Verificar expediente", exact=True)
        expect(verify).to_be_enabled()
        self.assertEqual(len(fixture.rows["case_files"]), 1)
        verify.click()
        self.assert_case_selected(page)
        self.assertEqual(fixture.case_creations[0], fixture.case_creations[1])
        self.assertEqual(len(fixture.rows["case_files"]), 2)

    def test_case_existing_number_selects_the_canonical_record_without_overwriting(self):
        for outside_cache in [False, True]:
            with self.subTest(outside_cache=outside_cache):
                page, fixture = self.open_app("case_normal")
                if outside_cache:
                    fixture.rows["case_files"].append({"id": "aaaaaaaa-aaaa-4aaa-8aaa-000000000009", "number": "EX-EXTERNO"})
                original = copy.deepcopy(fixture.rows["case_files"])
                number = "EX-EXTERNO" if outside_cache else "TEST-001"
                self.case_form(page, number.lower()).click()
                expect(page.locator(".case-creation-column").get_by_role("status")).to_have_text(f"El expediente {number} ya existe. Se seleccionó para agregar documentos.")
                self.assert_case_selected(page, number)
                self.assertEqual(fixture.rows["case_files"], original)
                self.assertEqual(len(fixture.case_creations), 1)
                if outside_cache:
                    page.locator(".workspace-grid").screenshot(path="/tmp/rastreodoc-aviso-expediente.png")

    def test_case_known_rollback_unlocks_the_form_for_a_corrected_capture(self):
        page, fixture = self.open_app("case_rollback")
        self.case_form(page).click()
        expect(page.get_by_role("status")).to_contain_text("No se guardó el expediente.")
        expect(page.get_by_label("Número de expediente", exact=True)).to_be_enabled()
        expect(page.get_by_label("Número de expediente", exact=True)).to_have_value("EX-NUEVO")
        page.get_by_label("Número de expediente", exact=True).fill("EX-CORREGIDO")
        page.get_by_role("button", name="Guardar expediente", exact=True).click()
        self.assert_case_selected(page, "EX-CORREGIDO")
        self.assertNotEqual(fixture.case_creations[0]["id"], fixture.case_creations[1]["id"])
        self.assertEqual(len(fixture.rows["case_files"]), 2)

    def test_case_failed_verification_keeps_the_original_pending_capture(self):
        page, fixture = self.open_app("case_verify_expired")
        self.case_form(page).click()
        verify = page.get_by_role("button", name="Verificar expediente", exact=True)
        expect(verify).to_be_enabled()
        verify.click()
        expect(verify).to_be_enabled()
        expect(page.get_by_label("Número de expediente", exact=True)).to_have_value("EX-NUEVO")
        expect(page.get_by_label("Número de expediente", exact=True)).to_be_disabled()
        fixture.scenario = "case_normal"
        verify.click()
        self.assert_case_selected(page)
        self.assertEqual(len(fixture.case_creations), 1)

    def test_case_inflight_request_locks_capture_and_scanner(self):
        page, fixture = self.open_app("case_delayed")
        self.case_form(page).evaluate("button=>{button.click();button.click();}")
        expect(page.get_by_label("Número de expediente", exact=True)).to_be_disabled()
        expect(page.get_by_label("Buscar expediente", exact=True)).to_be_disabled()
        page.get_by_role("navigation", name="Menú principal").get_by_role("button", name="Escanear", exact=True).click()
        expect(page.get_by_label("Código QR", exact=True)).to_be_disabled()
        for button in page.locator(".scan-modes button").all():
            expect(button).to_be_disabled()
        expect(page.get_by_role("button", name="Procesando expediente…", exact=True)).to_be_disabled()
        self.assertIsNotNone(fixture.held_case)
        fixture.release_case()
        expect(page.get_by_role("status")).to_contain_text("guardado correctamente.")
        expect(page.get_by_label("Código QR", exact=True)).to_be_enabled()
        self.assertEqual(len(fixture.case_creations), 1)

    def test_case_timeout_keeps_verification_and_ignores_a_late_old_insert(self):
        page, fixture = self.open_app("case_timeout")
        page.clock.install()
        self.case_form(page).click()
        expect(page.get_by_label("Número de expediente", exact=True)).to_be_disabled()
        deadline = time.monotonic() + 5
        while fixture.held_case is None and time.monotonic() < deadline:
            page.wait_for_timeout(20)
        self.assertIsNotNone(fixture.held_case)
        page.clock.fast_forward(21000)
        verify = page.get_by_role("button", name="Verificar expediente", exact=True)
        expect(verify).to_be_enabled()
        expect(page.get_by_label("Número de expediente", exact=True)).to_be_disabled()
        verify.click()
        self.assert_case_selected(page)
        fixture.release_case()
        expect(page.get_by_role("status")).to_have_text("Expediente EX-NUEVO guardado correctamente.")
        self.assertEqual(fixture.case_creations[0], fixture.case_creations[1])
        self.assertEqual(len(fixture.rows["case_files"]), 2)

    def test_creation_has_one_insert_without_catalog_or_report_reload_and_prints_saved_qr(self):
        page, fixture = self.open_app("creation_normal")
        initial_reads = len(fixture.reads)
        self.alta(page)
        self.assertEqual(len(fixture.reads), initial_reads, "Opening Alta should reuse the loaded workspace")
        page.get_by_role("button", name="Agregar documento", exact=True).evaluate("button=>{button.click();button.click();}")
        saved = page.get_by_role("region", name="Último documento guardado")
        expect(saved).to_contain_text("TEST-001 · CERTIFICADO — Nuevo de prueba")
        self.assertEqual(len(fixture.creations), 1)
        self.assertEqual(fixture.creation_movements, 1)
        self.assertEqual(len(fixture.reads), initial_reads, "A known-catalog capture should only insert the document")
        saved.get_by_role("button", name="Ver e imprimir QR").click()
        dialog = page.get_by_role("dialog", name="Código QR del documento", exact=True)
        image = dialog.get_by_role("img")
        expect(image).to_have_attribute("src", re.compile(r"^data:image/png;base64,"))
        page.wait_for_function("()=>document.querySelector('.qr-modal img')?.naturalWidth===420")
        self.spy_print(page)
        with page.expect_popup() as opened:
            dialog.get_by_role("button", name="Imprimir etiqueta 40 × 30 mm").click()
        popup = opened.value
        popup.wait_for_function("()=>window.__printCalls?.length===1")
        self.assertEqual(popup.evaluate("window.__printCalls"), [{"labels": 1, "allDecoded": True}])
        self.assertEqual(popup.locator(".case").inner_text(), "TEST-001")
        self.assertEqual(popup.locator(".document-type").inner_text(), "CERTIFICADO")
        self.assertEqual(popup.locator("img").get_attribute("src"), image.get_attribute("src"))
        popup.locator(".label").screenshot(path="/tmp/rastreodoc-etiqueta-40x30-prueba.png")
        self.assert_label_pdf(popup, 1, "/tmp/rastreodoc-etiqueta-prueba.pdf")
        dialog.get_by_role("button", name="Imprimir etiqueta 40 × 30 mm").evaluate("button=>{button.click();button.click();}")
        self.assertEqual(len(page.context.pages), 2, "A repeated print click should focus the existing label window")

    def test_creation_lost_reply_verifies_one_document_without_a_second_insert(self):
        page, fixture = self.open_app("creation_lost_reply")
        self.alta(page)
        page.get_by_role("button", name="Agregar documento", exact=True).click()
        verify = page.get_by_role("button", name="Verificar alta", exact=True)
        expect(verify).to_be_visible()
        expect(page.get_by_label("Buscar expediente", exact=True)).to_be_disabled()
        expect(page.get_by_role("status")).to_contain_text("El documento podría haberse guardado")
        self.assertEqual(len(fixture.created_documents), 1)
        page.evaluate("()=>window.location.reload()")
        deadline = time.monotonic() + 5
        while "beforeunload" not in fixture.dialog_types and time.monotonic() < deadline:
            page.wait_for_timeout(20)
        self.assertIn("beforeunload", fixture.dialog_types)
        expect(verify).to_be_visible()
        verify.evaluate("button=>{button.click();button.click();}")
        expect(verify).not_to_be_visible()
        expect(page.get_by_role("region", name="Último documento guardado")).to_contain_text("Nuevo de prueba")
        self.assertEqual(len(fixture.creations), 1)
        self.assertEqual(fixture.creation_movements, 1)

    def test_creation_still_creates_missing_manual_catalog_entries(self):
        page, fixture = self.open_app("creation_new_catalog")
        self.alta(page)
        page.get_by_label("Tipo de documento").select_option("OTROS")
        page.get_by_label("Dependencia manual").fill("OFICINA FICTICIA")
        page.get_by_role("button", name="Agregar documento", exact=True).click()
        expect(page.get_by_role("region", name="Último documento guardado")).to_contain_text("TEST-001 · OTROS — Nuevo de prueba")
        self.assertEqual({item["table"] for item in fixture.catalog_writes}, {"document_types", "agencies"})
        self.assertEqual(len(fixture.creations), 1)
        self.assertEqual(fixture.creation_movements, 1)

    def test_creation_before_commit_retries_the_same_id_and_creates_one_initial_movement(self):
        page, fixture = self.open_app("creation_before_commit")
        self.alta(page)
        page.get_by_role("button", name="Agregar documento", exact=True).click()
        verify = page.get_by_role("button", name="Verificar alta", exact=True)
        expect(verify).to_be_visible()
        self.assertEqual(fixture.created_documents, {})
        verify.click()
        expect(verify).not_to_be_visible()
        expect(page.get_by_role("region", name="Último documento guardado")).to_contain_text("Nuevo de prueba")
        self.assertEqual(len(fixture.creations), 2)
        self.assertEqual(fixture.creations[0], fixture.creations[1])
        self.assertEqual(len(fixture.created_documents), 1)
        self.assertEqual(fixture.creation_movements, 1)

    def test_batch_print_includes_every_selected_ready_document_in_order_after_decode(self):
        def documents(fixture):
            for number, status in [(2, "EN_OFICINA"), (3, "EN_OFICINA"), (4, "AUTORIZADO")]:
                item = copy.deepcopy(fixture.document)
                item.update(id=f"aaaaaaaa-aaaa-4aaa-8aaa-{number:012d}", qr_token=f"bbbbbbbb-bbbb-4bbb-8bbb-{number:012d}", status=status)
                item["case_files"] = {"number": f"TEST-{number:03d}"}
                fixture.extra_documents.append(item)
        page, fixture = self.open_app("normal", configure=documents)
        self.spy_print(page)
        page.get_by_role("navigation", name="Menú principal").get_by_role("button", name="Buscar", exact=True).click()
        for checkbox in page.locator(".qr-select input").all():
            checkbox.check()
        with page.expect_popup() as opened:
            page.get_by_role("button", name="Imprimir QR seleccionados (3)", exact=True).click()
        popup = opened.value
        popup.wait_for_function("()=>window.__printCalls?.length===1")
        self.assertEqual(popup.locator(".case").all_inner_texts(), ["TEST-001", "TEST-002", "TEST-003"])
        self.assertEqual(popup.evaluate("window.__printCalls"), [{"labels": 3, "allDecoded": True}])
        self.assert_label_pdf(popup, 3, "/tmp/rastreodoc-lote-etiquetas-prueba.pdf")
        self.assertEqual(fixture.operations, [])

    def test_blocked_popup_shows_an_actionable_message_and_can_be_retried(self):
        page, _ = self.open_app("normal")
        page.get_by_role("navigation", name="Menú principal").get_by_role("button", name="Buscar", exact=True).click()
        page.locator(".qr-select input").check()
        page.evaluate("()=>{window.__originalOpen=window.open;window.open=()=>null;}")
        print_button = page.get_by_role("button", name="Imprimir QR seleccionados (1)", exact=True)
        print_button.click()
        expect(page.get_by_role("status")).to_contain_text("Permite las ventanas emergentes")
        expect(print_button).to_be_enabled()
        page.evaluate("()=>{window.open=window.__originalOpen;}")
        self.spy_print(page)
        with page.expect_popup() as opened:
            print_button.click()
        opened.value.wait_for_function("()=>window.__printCalls?.length===1")

    def test_failed_image_does_not_print_an_incomplete_batch(self):
        page, _ = self.open_app("normal")
        self.spy_print(page, broken_image=True)
        page.get_by_role("navigation", name="Menú principal").get_by_role("button", name="Buscar", exact=True).click()
        page.locator(".qr-select input").check()
        with page.expect_popup() as opened:
            page.get_by_role("button", name="Imprimir QR seleccionados (1)", exact=True).click()
        popup = opened.value
        expect(popup.get_by_role("alert")).to_contain_text("No se pudieron cargar todos los QR")
        self.assertEqual(popup.evaluate("window.__printCalls"), [])
        expect(popup.get_by_role("button", name="Preparando impresión…", exact=True)).to_be_disabled()

    def test_receipt_double_submission_uses_one_atomic_request(self):
        page, fixture = self.open_app("normal")
        self.boletas(page)
        # Two DOM clicks in one event turn exercise the synchronous write guard,
        # before React's disabled state can prevent the second submission.
        page.get_by_role("button", name="Marcar ENVIADO", exact=True).evaluate("button => { button.click(); button.click(); }")
        expect(page.get_by_role("status")).to_contain_text("Boleta guardada. Documento marcado como ENVIADO.")
        self.assertEqual(len(fixture.operations), 1)
        self.assertEqual(fixture.operations[0]["p_receipt_number"], "B-TEST-123")
        self.assertEqual(len(fixture.receipts), 1)

    def test_lost_response_is_verified_with_the_same_id_and_payload(self):
        page, fixture = self.open_app("lost_response")
        self.boletas(page)
        page.get_by_role("button", name="Marcar ENVIADO", exact=True).click()
        verify = page.get_by_role("button", name="Verificar guardado", exact=True)
        expect(verify).to_be_visible()
        expect(page.get_by_role("status")).to_contain_text("No se pudo confirmar el guardado")
        self.assertEqual(len(fixture.operations), 1)
        verify.click()
        expect(page.get_by_role("status")).to_contain_text("Guardado confirmado. Estatus actual: ENVIADO.")
        expect(verify).not_to_be_visible()
        self.assertEqual(len(fixture.operations), 2)
        self.assertEqual(fixture.operations[0], fixture.operations[1])
        self.assertEqual(len(fixture.receipts), 1)
        self.assertEqual(len(fixture.movements), 1)

    def test_correction_uses_one_rpc_and_reloads_a_conflicting_document(self):
        page, fixture = self.open_app("conflict")
        page.get_by_role("navigation", name="Menú principal").get_by_role("button", name="Buscar", exact=True).click()
        page.get_by_role("button", name="Editar", exact=True).click()
        dialog = page.get_by_role("dialog", name="Editar documento", exact=True)
        dialog.get_by_label("Identificador para distinguirlo (opcional)").fill("Etiqueta corregida")
        dialog.get_by_label("Estatus correcto").select_option("AUTORIZADO")
        dialog.get_by_role("button", name="Guardar cambios", exact=True).click()
        expect(dialog).not_to_be_visible()
        expect(page.get_by_role("status")).to_contain_text("Esta operación no se guardó.")
        expect(page.get_by_text("TEST-001 · CERTIFICADO — Cambio de otra computadora", exact=True)).to_be_visible()
        self.assertEqual(len(fixture.operations), 1)
        args = fixture.operations[0]
        self.assertEqual(args["p_label"], "Etiqueta corregida")
        self.assertEqual(args["p_requested_status"], "AUTORIZADO")
        self.assertTrue(args["p_change_label"])
        self.assertTrue(args["p_is_correction"])
        self.assertEqual(fixture.receipts, {})

    def test_correction_lost_response_can_be_verified_inside_its_modal(self):
        page, fixture = self.open_app("lost_response")
        page.get_by_role("navigation", name="Menú principal").get_by_role("button", name="Buscar", exact=True).click()
        page.get_by_role("button", name="Editar", exact=True).click()
        dialog = page.get_by_role("dialog", name="Editar documento", exact=True)
        dialog.get_by_label("Identificador para distinguirlo (opcional)").fill("Etiqueta corregida")
        dialog.get_by_label("Estatus correcto").select_option("AUTORIZADO")
        dialog.get_by_role("button", name="Guardar cambios", exact=True).click()
        verify = dialog.get_by_role("button", name="Verificar guardado", exact=True)
        expect(verify).to_be_visible()
        expect(dialog.get_by_role("button", name="Guardar cambios", exact=True)).to_be_disabled()
        verify.click()
        expect(dialog).not_to_be_visible()
        expect(page.get_by_role("status")).to_contain_text("Guardado confirmado. Estatus actual: AUTORIZADO.")
        expect(page.get_by_text("TEST-001 · CERTIFICADO — Etiqueta corregida", exact=True)).to_be_visible()
        self.assertEqual(len(fixture.operations), 2)
        self.assertEqual(fixture.operations[0], fixture.operations[1])
        self.assertEqual(len(fixture.receipts), 1)
        self.assertEqual(len(fixture.movements), 1)

    def test_failed_verification_preserves_original_id_for_another_verification(self):
        page, fixture = self.open_app("lost_then_expired")
        self.boletas(page)
        page.get_by_role("button", name="Marcar ENVIADO", exact=True).click()
        verify = page.get_by_role("button", name="Verificar guardado", exact=True)
        expect(verify).to_be_visible()
        verify.click()
        expect(page.get_by_role("status")).to_contain_text("No se pudo confirmar el guardado")
        expect(verify).to_be_visible()
        expect(page.get_by_role("button", name="Marcar ENVIADO", exact=True)).to_be_disabled()
        self.assertEqual(len(fixture.operations), 2)
        verify.click()
        expect(page.get_by_role("status")).to_contain_text("Guardado confirmado. Estatus actual: ENVIADO.")
        expect(verify).not_to_be_visible()
        self.assertEqual(len(fixture.operations), 3)
        self.assertEqual(fixture.operations[0], fixture.operations[1])
        self.assertEqual(fixture.operations[0], fixture.operations[2])
        self.assertEqual(len(fixture.receipts), 1)
        self.assertEqual(len(fixture.movements), 1)

    def test_delayed_scan_locks_qr_and_mode_until_its_operation_finishes(self):
        page, fixture = self.open_app("delayed_scan")
        page.get_by_role("navigation", name="Menú principal").get_by_role("button", name="Escanear", exact=True).click()
        authorized = page.get_by_role("button", name="AUTORIZADO", exact=True)
        rejected = page.get_by_role("button", name="RECHAZADO", exact=True)
        authorized.click()
        qr = page.get_by_role("textbox", name="Código QR", exact=True)
        qr.fill(fixture.document["qr_token"])
        page.get_by_role("button", name="Registrar lectura", exact=True).click()
        expect(qr).to_be_disabled()
        expect(authorized).to_be_disabled()
        expect(rejected).to_be_disabled()
        self.assertIsNotNone(fixture.held_lookup)
        self.assertEqual(fixture.operations, [])
        rejected.evaluate("button => button.click()")
        expect(page.get_by_text("Modo activo: AUTORIZADO. Cada lectura se guardará automáticamente.", exact=True)).to_be_visible()
        fixture.release_lookup()
        # Wait through the real UI loop until the operation request is held.
        page.wait_for_function("() => document.body.innerText.includes('CERTIFICADO')")
        deadline = time.monotonic() + 5
        while fixture.held_operation is None and time.monotonic() < deadline:
            page.wait_for_timeout(20)
        self.assertIsNotNone(fixture.held_operation)
        expect(qr).to_be_disabled()
        expect(authorized).to_be_disabled()
        expect(rejected).to_be_disabled()
        self.assertEqual(len(fixture.operations), 1)
        self.assertEqual(fixture.operations[0]["p_document_id"], DOC_ID)
        self.assertEqual(fixture.operations[0]["p_requested_status"], "AUTORIZADO")
        fixture.release_operation()
        expect(page.get_by_role("status")).to_contain_text("Movimiento registrado: AUTORIZADO.")
        expect(qr).to_be_enabled()
        expect(authorized).to_be_enabled()
        expect(rejected).to_be_enabled()
        expect(qr).to_be_focused()
        self.assertEqual(len(fixture.operations), 1)


def main():
    chromium = shutil.which("chromium") or shutil.which("chromium-browser")
    if not chromium:
        raise SystemExit("Chromium is required for this local browser check.")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    env = os.environ.copy()
    env.update({
        "NEXT_PUBLIC_SUPABASE_URL": f"https://{API_HOST}",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": "fictional-browser-fixture-key",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY": "fictional-browser-fixture-key",
        "NEXT_PUBLIC_DATABASE_STORAGE_LIMIT_MB": "8192",
        "NEXT_TELEMETRY_DISABLED": "1",
    })
    # Inherit proxy/CA settings; all browser API traffic is intercepted locally.
    log = tempfile.TemporaryFile(mode="w+")
    agents_path = ROOT / "AGENTS.md"
    agents_before = agents_path.read_bytes() if agents_path.exists() else None
    process = subprocess.Popen(
        ["npm", "run", "dev", "--", "--hostname", "127.0.0.1", "--port", str(port)],
        cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    try:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError("Local development server exited before readiness.")
            try:
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
                connection.request("GET", "/")
                response = connection.getresponse()
                response.read()
                connection.close()
                if response.status == 200:
                    break
                if response.status >= 500:
                    raise RuntimeError(f"Local page returned HTTP {response.status} during readiness.")
            except (OSError, TimeoutError):
                pass
            time.sleep(0.2)
        else:
            raise RuntimeError("Local development server did not become ready.")
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=chromium, headless=True)
            try:
                BrowserOperations.base_url = origin
                BrowserOperations.browser = browser
                suite = unittest.defaultTestLoader.loadTestsFromTestCase(BrowserOperations)
                result = unittest.TextTestRunner(verbosity=2).run(suite)
                return 0 if result.wasSuccessful() else 1
            finally:
                browser.close()
    except Exception:
        log.seek(0)
        sys.stderr.write(log.read()[-8000:])
        raise
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
        # Next dev rewrites this generated heading. Restore only that exact
        # change, without undoing another agent's concurrent instructions.
        if agents_before is not None and agents_path.exists():
            expected_generated = agents_before.replace(
                b"\n# This is NOT the Next.js you know\n",
                b"\n## This is NOT the Next.js you know\n",
            )
            if agents_path.read_bytes() == expected_generated:
                agents_path.write_bytes(agents_before)
        log.close()


if __name__ == "__main__":
    raise SystemExit(main())
