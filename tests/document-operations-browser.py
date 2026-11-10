#!/usr/bin/env python3
"""Local browser checks with a fully intercepted, fictional Supabase API.

Requires Python Playwright and Chromium. Run from the repository root:
    python tests/document-operations-browser.py

The script starts its own Next development server with fake public settings,
blocks every nonlocal destination except the intercepted fixture hostname, and
stops only the process group that it created. It never uses a real database.
"""

import base64
import copy
import http.client
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright


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
            now = int(time.time())
            user = {"id": USER_ID, "aud": "authenticated", "role": "authenticated", "email": "prueba@example.invalid", "app_metadata": {}, "user_metadata": {}}
            token = ".".join([
                jwt_part({"alg": "HS256", "typ": "JWT"}),
                jwt_part({"sub": USER_ID, "aud": "authenticated", "role": "authenticated", "exp": now + 3600, "iat": now}),
                "fictional-test-signature",
            ])
            self.fulfill(route, {"access_token": token, "token_type": "bearer", "expires_in": 3600, "expires_at": now + 3600, "refresh_token": "fictional-refresh-token", "user": user} if parsed.path.endswith("/token") else user)
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
        if parsed.path.startswith("/rest/v1/"):
            table = parsed.path.split("/")[-1]
            if request.method != "GET":
                self.direct_writes.append({"table": table, "method": request.method})
                self.fulfill(route, {"code": "PT422", "message": "Unexpected direct table write in browser test"}, 422)
                return
            query = parse_qs(parsed.query)
            if table == "documents":
                archived = query.get("archived_at", [""])[0]
                rows = [] if archived == "not.is.null" else [copy.deepcopy(self.document)]
                if self.scenario == "delayed_scan" and "qr_token" in query:
                    self.held_lookup = (route, rows)
                    return
            elif table == "movements":
                rows = copy.deepcopy(self.movements)
            else:
                rows = copy.deepcopy(self.rows.get(table, []))
            if "application/vnd.pgrst.object+json" in request.headers.get("accept", ""):
                self.fulfill(route, rows[0] if rows else None)
            else:
                self.fulfill(route, rows)
            return
        self.fulfill(route, {"message": "Unexpected fixture path"}, 404)

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

    def open_app(self, scenario):
        context = self.browser.new_context()
        self.addCleanup(context.close)
        fixture = SupabaseFixture(self.base_url, scenario)
        context.route("**/*", fixture.route)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("dialog", lambda dialog: dialog.accept())
        page.goto(self.base_url, wait_until="domcontentloaded")
        page.get_by_label("Usuario o correo").fill("prueba")
        page.get_by_label("Contraseña", exact=True).fill("fictional-test-password")
        page.get_by_role("button", name="Ingresar", exact=True).click()
        expect(page.get_by_role("navigation", name="Menú principal")).to_be_visible()
        expect(page.get_by_text("prueba", exact=True).first).to_be_visible()
        self.addCleanup(lambda: self.assertEqual(errors, [], "Browser runtime errors"))
        self.addCleanup(lambda: self.assertEqual(fixture.unexpected_hosts, [], "An unexpected external destination was blocked"))
        self.addCleanup(lambda: self.assertEqual(fixture.direct_writes, [], "UI must use the atomic RPC"))
        return page, fixture

    def boletas(self, page):
        page.get_by_role("navigation", name="Menú principal").get_by_role("button", name="Boletas", exact=True).click()
        expect(page.get_by_text("TEST-001 · CERTIFICADO — Original", exact=True)).to_be_visible()
        page.get_by_label("Número de boleta", exact=True).fill("B-TEST-123")

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
