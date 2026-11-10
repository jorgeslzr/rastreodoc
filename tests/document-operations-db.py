#!/usr/bin/env python3
"""Test the real SQL in a disposable, socket-only PostgreSQL cluster.

Run: PG_BIN=/path/to/postgresql/bin python tests/document-operations-db.py
Requires PostgreSQL server/client binaries with pgcrypto and citext installed.
Never uses an existing database, connection string, or Supabase credentials.
"""

import concurrent.futures
import getpass
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
import uuid


REPOSITORY = Path(__file__).resolve().parents[1]
MIGRATION = REPOSITORY / "supabase/migrations/20261110_atomic_document_operations.sql"
ACTOR = "00000000-0000-0000-0000-000000000001"
OTHER_ACTOR = "00000000-0000-0000-0000-000000000002"
AGENCY = "00000000-0000-0000-0000-000000000010"
CERTIFICATE = "00000000-0000-0000-0000-000000000011"
ISAI = "00000000-0000-0000-0000-000000000012"
CASE_FILE = "00000000-0000-0000-0000-000000000013"


def literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "true" if value else "false"
    return "'" + str(value).replace("'", "''") + "'"


def find_binaries():
    candidates = []
    if os.environ.get("PG_BIN"):
        candidates.append(Path(os.environ["PG_BIN"]))
    if shutil.which("postgres"):
        candidates.append(Path(shutil.which("postgres")).parent)
    candidates.extend(sorted(Path("/usr/lib/postgresql").glob("*/bin"), reverse=True))
    for candidate in candidates:
        if all((candidate / name).is_file() for name in ["postgres", "initdb", "pg_ctl", "psql"]):
            return candidate
    raise RuntimeError("Install PostgreSQL server/client with citext and pgcrypto; set PG_BIN to its bin directory.")


class DatabaseOperations(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bin = find_binaries()
        cls.temp = tempfile.TemporaryDirectory(prefix="rastreadoc-db-test-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        cls.data = cls.root / "data"
        cls.socket = cls.root / "socket"
        cls.socket.mkdir(mode=0o700)
        cls.run_tool("initdb", "-D", str(cls.data), "--no-locale", "--encoding=UTF8", "--auth-local=trust", "--auth-host=reject")
        # No TCP listener: even an inherited remote PGHOST cannot redirect tests.
        cls.run_tool("pg_ctl", "-D", str(cls.data), "-l", str(cls.root / "server.log"), "-w", "start", "-o",
                     f"-k {cls.socket} -p 65432 -c listen_addresses='' -c unix_socket_permissions=0700 -c max_connections=20 -c shared_buffers=32MB -c fsync=off")
        cls.addClassCleanup(cls.run_tool, "pg_ctl", "-D", str(cls.data), "-w", "stop", "-m", "immediate")
        cls.connection = [str(cls.bin / "psql"), "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
                          "-v", "VERBOSITY=verbose", "-h", str(cls.socket), "-p", "65432", "-d", "postgres", "-U", getpass.getuser()]
        cls.run_sql("""
          create role anon nologin;
          create role authenticated nologin;
          create schema auth;
          grant usage on schema auth to authenticated;
          create table auth.users(id uuid primary key);
          create function auth.uid() returns uuid language sql stable as
            $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        """)
        # Bootstrap an ordinary current schema, then apply the additive migration
        # twice to verify upgrade and repeatability. No historical migrations run.
        schema = (REPOSITORY / "supabase/schema.sql").read_text()
        marker = "-- Guardados de documentos atómicos, con detección de conflictos e idempotencia."
        cls.run_sql(schema.split(marker)[0])
        cls.run_sql(MIGRATION.read_text())
        cls.run_sql(MIGRATION.read_text())
        cls.run_sql(schema)
        cls.run_sql(f"""
          insert into auth.users values ('{ACTOR}'), ('{OTHER_ACTOR}');
          insert into public.agencies(id,name) values ('{AGENCY}', 'REGISTRO PÚBLICO');
          insert into public.document_types(id,name) values ('{CERTIFICATE}', 'CERTIFICADO'), ('{ISAI}', 'ISAI');
          insert into public.case_files(id,number) values ('{CASE_FILE}', 'PRUEBA-LOCAL');
        """)

    @classmethod
    def run_tool(cls, name, *arguments):
        result = subprocess.run([str(cls.bin / name), *arguments], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(f"{name} failed: {result.stderr or result.stdout}")
        return result.stdout

    @classmethod
    def execute(cls, sql, actor=None, database=None):
        if actor is not None:
            sql = f"set role authenticated; set request.jwt.claim.sub = {literal(actor)};\n" + sql
        connection = cls.connection.copy()
        if database is not None:
            connection[connection.index("-d") + 1] = database
        return subprocess.run(connection, input=sql, capture_output=True, text=True)

    @classmethod
    def run_sql(cls, sql, actor=None, error=None, database=None):
        result = cls.execute(sql, actor, database)
        if error:
            if result.returncode == 0 or error not in result.stderr:
                raise AssertionError(f"Expected SQLSTATE {error}; got rc={result.returncode}: {result.stderr}")
        elif result.returncode:
            raise AssertionError(result.stderr)
        return result.stdout.strip()

    def new_document(self, document_type=CERTIFICATE):
        identifier = str(uuid.uuid4())
        self.run_sql(f"""
          insert into public.documents(id,case_file_id,document_type_id,agency_id,label)
          values ('{identifier}', '{CASE_FILE}', '{document_type}', '{AGENCY}', 'Original');
        """, actor=ACTOR)
        return self.document(identifier)

    def document(self, identifier):
        return json.loads(self.run_sql(f"select row_to_json(d) from public.documents d where id={literal(identifier)};"))

    def movement_count(self, identifier):
        return int(self.run_sql(f"select count(*) from public.movements where document_id={literal(identifier)};"))

    def operation_sql(self, snapshot, operation_id=None, **changes):
        parameters = dict(
            p_operation_id=operation_id or str(uuid.uuid4()),
            p_document_id=snapshot["id"],
            p_expected_status=snapshot["status"],
            p_expected_movement_at=snapshot["last_movement_at"],
            p_expected_label=snapshot["label"],
        )
        parameters.update(changes)
        return "select public.save_document_operation(" + ",".join(f"{key}=>{literal(value)}" for key, value in parameters.items()) + ");"

    def save(self, snapshot, operation_id=None, actor=ACTOR, error=None, **changes):
        output = self.run_sql(self.operation_sql(snapshot, operation_id, **changes), actor=actor, error=error)
        return None if error else json.loads(output)

    def new_empty_setup_database(self):
        # Each setup scenario starts with a separate local database. Roles are
        # cluster-wide and already exist; auth stubs are database-local.
        database = "setup_" + uuid.uuid4().hex
        self.run_sql(f'create database "{database}";')
        self.addCleanup(self.run_sql, f'drop database "{database}" with (force);')
        self.run_sql("""
          create schema auth;
          grant usage on schema auth to authenticated;
          create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz);
          create function auth.uid() returns uuid language sql stable as
            $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        """, database=database)
        return database

    def generated_test_setup(self):
        result = subprocess.run(
            ["node", str(REPOSITORY / "scripts/generate-test-project-setup.mjs")],
            cwd=REPOSITORY, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def public_tables(self, database):
        return json.loads(self.run_sql("""
          select coalesce(jsonb_agg(table_name order by table_name),'[]'::jsonb)
          from information_schema.tables where table_schema='public';
        """, database=database))

    def new_profile_test_database(self, confirmed=True):
        database = self.new_empty_setup_database()
        self.run_sql(self.generated_test_setup(), database=database)
        confirmation = "'2026-01-01T00:00:00Z'" if confirmed else "null"
        self.run_sql(f"""
          insert into auth.users(id,email,email_confirmed_at)
          values ('{ACTOR}','pruebas@usuarios.rastreadoc.mx',{confirmation});
        """, database=database)
        return database

    def test_test_profile_script_creates_admin_and_retry_is_idempotent(self):
        database = self.new_profile_test_database()
        profile_sql = (REPOSITORY / "scripts/test-project-profile.sql").read_text()
        self.assertEqual(self.run_sql(profile_sql, database=database), "pruebas|admin")
        snapshot_sql = "select jsonb_agg(to_jsonb(p) order by id) from public.profiles p;"
        profile_before = self.run_sql(snapshot_sql, database=database)
        profile = json.loads(profile_before)
        self.assertEqual(len(profile), 1)
        self.assertEqual(profile[0]["id"], ACTOR)
        self.assertEqual(profile[0]["username"], "pruebas")
        self.assertEqual(profile[0]["role"], "admin")
        self.assertEqual(self.run_sql(profile_sql, database=database), "pruebas|admin")
        self.assertEqual(self.run_sql(snapshot_sql, database=database), profile_before)

    def test_test_profile_script_rejects_wrong_project_without_changes(self):
        profile_sql = (REPOSITORY / "scripts/test-project-profile.sql").read_text()
        for changed_marker in ["case_number", "document_qr"]:
            with self.subTest(changed_marker=changed_marker):
                database = self.new_profile_test_database()
                if changed_marker == "case_number":
                    self.run_sql("update public.case_files set number='OTRO-PROYECTO';", database=database)
                else:
                    self.run_sql("""
                      update public.documents set qr_token='33333333-3333-4333-8333-333333333333'
                      where id='00000000-0000-4000-8000-000000000060';
                    """, database=database)
                snapshot_sql = """
                  select jsonb_build_object(
                    'users',(select jsonb_agg(to_jsonb(t) order by id) from auth.users t),
                    'case_files',(select jsonb_agg(to_jsonb(t) order by id) from public.case_files t),
                    'documents',(select jsonb_agg(to_jsonb(t) order by id) from public.documents t)
                  );
                """
                snapshot = self.run_sql(snapshot_sql, database=database)
                self.run_sql(profile_sql, database=database, error="P0001")
                self.assertEqual(self.run_sql(snapshot_sql, database=database), snapshot)
                self.assertEqual(self.run_sql("select count(*) from public.profiles;", database=database), "0")

    def test_test_profile_script_requires_confirmed_auth_user(self):
        database = self.new_profile_test_database(confirmed=False)
        snapshot_sql = "select jsonb_agg(to_jsonb(u) order by id) from auth.users u;"
        snapshot = self.run_sql(snapshot_sql, database=database)
        self.run_sql((REPOSITORY / "scripts/test-project-profile.sql").read_text(), database=database, error="P0001")
        self.assertEqual(self.run_sql(snapshot_sql, database=database), snapshot)
        self.assertEqual(self.run_sql("select count(*) from public.profiles;", database=database), "0")

    def test_test_profile_script_does_not_rename_or_promote_existing_profiles(self):
        profile_sql = (REPOSITORY / "scripts/test-project-profile.sql").read_text()
        for existing_profile in ["different_username", "different_role", "username_owned_by_other_user"]:
            with self.subTest(existing_profile=existing_profile):
                database = self.new_profile_test_database()
                if existing_profile == "different_username":
                    self.run_sql(f"insert into public.profiles(id,username,role) values ('{ACTOR}','preservar','admin');", database=database)
                elif existing_profile == "different_role":
                    self.run_sql(f"insert into public.profiles(id,username,role) values ('{ACTOR}','pruebas','consulta');", database=database)
                else:
                    self.run_sql(f"""
                      insert into auth.users(id,email,email_confirmed_at)
                      values ('{OTHER_ACTOR}','otro@usuarios.rastreadoc.mx','2026-01-01T00:00:00Z');
                      insert into public.profiles(id,username,role) values ('{OTHER_ACTOR}','pruebas','admin');
                    """, database=database)
                snapshot_sql = "select jsonb_agg(to_jsonb(p) order by id) from public.profiles p;"
                profile_before = self.run_sql(snapshot_sql, database=database)
                self.run_sql(profile_sql, database=database, error="P0001")
                self.assertEqual(self.run_sql(snapshot_sql, database=database), profile_before)

    def test_generated_setup_initializes_empty_test_project(self):
        database = self.new_empty_setup_database()
        self.assertEqual(self.public_tables(database), [])
        self.run_sql(self.generated_test_setup(), database=database)
        counts = json.loads(self.run_sql("""
          select jsonb_build_object(
            'users',(select count(*) from auth.users),
            'case_files',(select count(*) from public.case_files),
            'documents',(select count(*) from public.documents),
            'movements',(select count(*) from public.movements),
            'agencies',(select count(*) from public.agencies),
            'document_types',(select count(*) from public.document_types),
            'lawyers',(select count(*) from public.lawyers),
            'auxiliaries',(select count(*) from public.auxiliaries),
            'municipalities',(select count(*) from public.municipalities),
            'operation_receipts',(select count(*) from public.document_operation_receipts)
          );
        """, database=database))
        self.assertEqual(counts, dict(users=0, case_files=1, documents=2, movements=2,
                                     agencies=2, document_types=2, lawyers=1,
                                     auxiliaries=1, municipalities=1, operation_receipts=0))
        fixture_state = json.loads(self.run_sql("""
          select jsonb_build_object(
            'case_number',(select number from public.case_files),
            'document_labels',(select jsonb_agg(label order by label) from public.documents),
            'statuses',(select jsonb_agg(status order by id) from public.documents),
            'anonymous_initial_movements',(select count(*) from public.movements where created_by is null)
          );
        """, database=database))
        self.assertEqual(fixture_state["case_number"], "PRUEBA-001")
        self.assertEqual(fixture_state["document_labels"], ["DOCUMENTO FICTICIO 1", "DOCUMENTO FICTICIO 2"])
        self.assertEqual(fixture_state["statuses"], ["EN_OFICINA", "EN_OFICINA"])
        self.assertEqual(fixture_state["anonymous_initial_movements"], 2)

    def test_generated_setup_rejects_repeat_or_existing_public_table_without_changes(self):
        setup = self.generated_test_setup()
        for scenario in ["repeat", "existing_table"]:
            with self.subTest(scenario=scenario):
                database = self.new_empty_setup_database()
                if scenario == "repeat":
                    self.run_sql(setup, database=database)
                    snapshot_sql = """
                      select jsonb_build_object(
                        'case_files',(select jsonb_agg(to_jsonb(t) order by id) from public.case_files t),
                        'documents',(select jsonb_agg(to_jsonb(t) order by id) from public.documents t),
                        'movements',(select jsonb_agg(to_jsonb(t) order by id) from public.movements t),
                        'agencies',(select jsonb_agg(to_jsonb(t) order by id) from public.agencies t),
                        'document_types',(select jsonb_agg(to_jsonb(t) order by id) from public.document_types t)
                      );
                    """
                else:
                    self.run_sql("""
                      create table public.existing_data(id integer primary key, note text);
                      insert into public.existing_data values (1,'PRESERVAR');
                    """, database=database)
                    snapshot_sql = "select jsonb_agg(to_jsonb(t) order by id) from public.existing_data t;"
                tables_before = self.public_tables(database)
                rows_before = self.run_sql(snapshot_sql, database=database)
                self.run_sql(setup, database=database, error="P0001")
                self.assertEqual(self.public_tables(database), tables_before)
                self.assertEqual(self.run_sql(snapshot_sql, database=database), rows_before)

    def test_generated_setup_rejects_existing_auth_user_with_empty_public_schema(self):
        database = self.new_empty_setup_database()
        self.run_sql(f"insert into auth.users values ('{ACTOR}');", database=database)
        users_before = self.run_sql("select jsonb_agg(to_jsonb(t) order by id) from auth.users t;", database=database)
        self.assertEqual(self.public_tables(database), [])
        self.run_sql(self.generated_test_setup(), database=database, error="P0001")
        self.assertEqual(self.public_tables(database), [])
        self.assertEqual(self.run_sql("select jsonb_agg(to_jsonb(t) order by id) from auth.users t;", database=database), users_before)

    def test_guard_rollback_preserves_history_and_new_rpc(self):
        original = self.new_document()
        self.save(original, p_requested_status="ENVIADO", p_receipt_number="ROLLBACK-1")
        rollback = REPOSITORY / "supabase/rollback/20261110_atomic_document_operations_guards.sql"
        self.run_sql(rollback.read_text())
        try:
            self.run_sql(f"""
              insert into public.movements(document_id,status,created_by)
              values ({literal(original["id"])}, 'AUTORIZADO', {literal(ACTOR)});
              update public.documents set label='Legacy allowed again'
              where id={literal(original["id"])};
            """, actor=ACTOR)
            self.assertEqual(self.movement_count(original["id"]), 3)
            self.assertEqual(self.document(original["id"])["label"], "Legacy allowed again")
            receipts = self.run_sql(f"select count(*) from public.document_operation_receipts where document_id={literal(original['id'])};")
            self.assertEqual(receipts, "1")
            current = self.document(original["id"])
            result = self.save(current, p_requested_status="RECHAZADO")
            self.assertEqual(result["document"]["status"], "RECHAZADO")
            self.assertEqual(self.movement_count(original["id"]), 4)
        finally:
            self.run_sql(MIGRATION.read_text())

    def test_server_confirms_state_and_timestamp(self):
        original = self.new_document()
        result = self.save(original, p_requested_status="ENVIADO", p_receipt_number="B-1")
        stored = self.document(original["id"])
        self.assertEqual(result["document"]["status"], "ENVIADO")
        self.assertEqual(result["document"]["last_movement_at"], stored["last_movement_at"])
        self.assertGreater(stored["last_movement_at"], original["last_movement_at"])
        self.assertEqual(self.movement_count(original["id"]), 2)
        self.assertFalse(result["duplicate"])

    def test_retry_does_not_duplicate_and_returns_current_document(self):
        original = self.new_document()
        operation_id = str(uuid.uuid4())
        first = self.save(original, operation_id, p_requested_status="ENVIADO", p_receipt_number="B-2")
        retry = self.save(original, operation_id, p_requested_status="ENVIADO", p_receipt_number="B-2")
        self.assertTrue(retry["duplicate"])
        self.assertEqual(self.movement_count(original["id"]), 2)
        confirmed = self.save(first["document"], p_requested_status="AUTORIZADO")
        retry = self.save(original, operation_id, p_requested_status="ENVIADO", p_receipt_number="B-2")
        self.assertEqual(retry["document"]["status"], confirmed["document"]["status"])
        self.assertEqual(retry["recorded_status"], "ENVIADO")
        self.assertEqual(self.movement_count(original["id"]), 3)

    def test_operation_id_cannot_be_reused_for_other_payload_or_actor(self):
        original = self.new_document()
        operation_id = str(uuid.uuid4())
        self.save(original, operation_id, p_requested_status="ENVIADO", p_receipt_number="B-3")
        self.save(original, operation_id, p_requested_status="ENVIADO", p_receipt_number="DIFFERENT", error="PT409")
        self.save(original, operation_id, actor=OTHER_ACTOR, p_requested_status="ENVIADO", p_receipt_number="B-3", error="PT409")
        self.assertEqual(self.movement_count(original["id"]), 2)

    def test_stale_snapshot_is_rejected(self):
        original = self.new_document()
        self.save(original, p_requested_status="ENVIADO", p_receipt_number="B-4")
        self.save(original, p_requested_status="AUTORIZADO", error="PT409")
        self.assertEqual(self.document(original["id"])["status"], "ENVIADO")
        self.assertEqual(self.movement_count(original["id"]), 2)

    def test_two_concurrent_clients_record_only_one_movement(self):
        original = self.new_document()
        barrier = threading.Barrier(2)

        def attempt(receipt):
            sql = self.operation_sql(original, p_requested_status="ENVIADO", p_receipt_number=receipt)
            # Keep the winning transaction open while the second client waits.
            sql = "begin;" + sql + "select pg_sleep(0.3); commit;"
            barrier.wait(timeout=5)
            return self.execute(sql, actor=ACTOR)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, ["RACE-1", "RACE-2"]))
        self.assertEqual(sorted(result.returncode == 0 for result in results), [False, True])
        self.assertIn("PT409", next(result.stderr for result in results if result.returncode))
        self.assertEqual(self.movement_count(original["id"]), 2)

    def test_two_concurrent_retries_confirm_the_same_operation(self):
        original = self.new_document()
        operation_id = str(uuid.uuid4())
        sql = self.operation_sql(original, operation_id, p_requested_status="ENVIADO", p_receipt_number="SAME")
        barrier = threading.Barrier(2)

        def attempt(_):
            barrier.wait(timeout=5)
            return self.execute("begin;" + sql + "select pg_sleep(0.3); commit;", actor=ACTOR)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, range(2)))
        for result in results:
            self.assertEqual(result.returncode, 0, result.stderr)
        confirmations = [json.loads(result.stdout.strip()) for result in results]
        self.assertEqual(sorted(result["duplicate"] for result in confirmations), [False, True])
        self.assertEqual(self.movement_count(original["id"]), 2)

    def test_same_operation_id_on_different_documents_rolls_back_the_loser(self):
        originals = [self.new_document(), self.new_document()]
        operation_id = str(uuid.uuid4())
        barrier = threading.Barrier(2)

        def attempt(snapshot):
            sql = self.operation_sql(snapshot, operation_id, p_requested_status="AUTORIZADO",
                                     p_change_label=True, p_label="Changed", p_is_correction=True)
            barrier.wait(timeout=5)
            return self.execute("begin;" + sql + "select pg_sleep(0.3); commit;", actor=ACTOR)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, originals))
        self.assertEqual(sorted(result.returncode == 0 for result in results), [False, True])
        for original, result in zip(originals, results):
            stored = self.document(original["id"])
            if result.returncode:
                self.assertIn("PT409", result.stderr)
                self.assertEqual(stored["status"], "EN_OFICINA")
                self.assertEqual(stored["label"], "Original")
                self.assertEqual(self.movement_count(original["id"]), 1)
            else:
                self.assertEqual(stored["status"], "AUTORIZADO")
                self.assertEqual(stored["label"], "Changed")
                self.assertEqual(self.movement_count(original["id"]), 2)
        receipt_count = self.run_sql(f"select count(*) from public.document_operation_receipts where operation_id={literal(operation_id)};")
        self.assertEqual(receipt_count, "1")

    def test_correction_rolls_back_label_and_operation_receipt_when_movement_fails(self):
        original = self.new_document()
        operation_id = str(uuid.uuid4())
        self.run_sql("""
          create function public.test_fail_movement() returns trigger language plpgsql as $$
          begin
            if new.notes = 'FORCE_TEST_ROLLBACK' then
              raise sqlstate '23514' using message='Failure injected by isolated test';
            end if;
            return new;
          end; $$;
          create trigger test_failure before insert on public.movements
          for each row execute function public.test_fail_movement();
        """)
        try:
            self.save(original, operation_id, p_requested_status="AUTORIZADO", p_change_label=True,
                      p_label="Changed", p_is_correction=True, p_notes="FORCE_TEST_ROLLBACK", error="23514")
            self.assertEqual(self.document(original["id"])["label"], "Original")
            self.assertEqual(self.document(original["id"])["status"], "EN_OFICINA")
            self.assertEqual(self.movement_count(original["id"]), 1)
            receipt_count = self.run_sql(f"select count(*) from public.document_operation_receipts where operation_id={literal(operation_id)};")
            self.assertEqual(receipt_count, "0")
        finally:
            self.run_sql("drop trigger test_failure on public.movements; drop function public.test_fail_movement();")
        result = self.save(original, operation_id, p_requested_status="AUTORIZADO", p_change_label=True,
                           p_label="Changed", p_is_correction=True, p_notes="FORCE_TEST_ROLLBACK")
        self.assertEqual(result["document"]["label"], "Changed")
        self.assertEqual(result["document"]["status"], "AUTORIZADO")

    def test_label_only_correction_and_stale_label_detection(self):
        original = self.new_document()
        result = self.save(original, p_change_label=True, p_label="Corrected", p_is_correction=True)
        self.assertEqual(result["document"]["label"], "Corrected")
        self.save(original, p_requested_status="ENVIADO", p_receipt_number="STALE-LABEL", error="PT409")
        self.assertIsNone(result["recorded_status"])
        self.assertEqual(self.movement_count(original["id"]), 1)
        self.save(original, p_change_label=True, p_label="Other", p_is_correction=True, error="PT409")

    def test_receipt_required_except_isai(self):
        certificate = self.new_document()
        self.save(certificate, p_requested_status="ENVIADO", error="PT422")
        self.assertEqual(self.movement_count(certificate["id"]), 1)
        isai = self.new_document(ISAI)
        result = self.save(isai, p_requested_status="ENVIADO")
        self.assertEqual(result["document"]["status"], "ENVIADO")

    def test_reentry_is_resolved_in_database(self):
        snapshot = self.new_document()
        original_id = snapshot["id"]
        for status, receipt in [("ENVIADO", "FIRST"), ("RECHAZADO", None), ("EN_OFICINA", None), ("ENVIADO", "SECOND")]:
            snapshot = self.save(snapshot, p_requested_status=status, p_receipt_number=receipt)["document"]
        self.assertEqual(snapshot["status"], "REENVIADO")
        self.assertEqual(self.movement_count(original_id), 5)

    def test_repeated_status_and_repeated_send_are_rejected(self):
        original = self.new_document()
        self.save(original, p_requested_status="EN_OFICINA", error="PT422")
        sent = self.save(original, p_requested_status="ENVIADO", p_receipt_number="ONE")["document"]
        self.save(sent, p_requested_status="ENVIADO", p_receipt_number="TWO", error="PT422")
        self.assertEqual(self.movement_count(original["id"]), 2)

    def test_archived_document_cannot_receive_new_operations(self):
        original = self.new_document()
        self.run_sql(f"update public.documents set archived_at=now() where id={literal(original['id'])};")
        self.save(original, p_requested_status="AUTORIZADO", error="PT409")
        self.assertEqual(self.movement_count(original["id"]), 1)

    def test_database_enforces_lengths(self):
        original = self.new_document()
        self.save(original, p_change_label=True, p_label="x" * 121, p_is_correction=True, error="PT422")
        self.save(original, p_requested_status="ENVIADO", p_receipt_number="x" * 101, error="PT422")
        self.save(original, p_requested_status="RECHAZADO", p_rejection_reason="x" * 251, error="PT422")
        self.assertEqual(self.movement_count(original["id"]), 1)
        self.assertEqual(self.document(original["id"])["label"], "Original")

    def test_movement_history_stays_immutable(self):
        original = self.new_document()
        self.run_sql(f"update public.movements set notes='Changed' where document_id={literal(original['id'])};", error="P0001")
        self.run_sql(f"delete from public.movements where document_id={literal(original['id'])};", error="P0001")
        self.assertEqual(self.movement_count(original["id"]), 1)

    def test_session_required_and_receipts_are_not_directly_accessible(self):
        original = self.new_document()
        self.save(original, actor="", p_requested_status="AUTORIZADO", error="PT401")
        self.run_sql("select * from public.document_operation_receipts;", actor=ACTOR, error="42501")

    def test_authenticated_document_creation_still_creates_initial_movement(self):
        original = self.new_document()
        self.assertEqual(original["status"], "EN_OFICINA")
        self.assertEqual(self.movement_count(original["id"]), 1)
        creator = self.run_sql(f"select created_by from public.movements where document_id={literal(original['id'])};")
        self.assertEqual(creator, ACTOR)

    def test_legacy_insert_is_rejected_even_with_forged_context(self):
        original = self.new_document()
        sql = f"""
          insert into public.movements(document_id,status,created_by)
          values ({literal(original['id'])}, 'AUTORIZADO', '{ACTOR}');
        """
        self.run_sql(sql, actor=ACTOR, error="PT409")
        context = json.dumps({"operation_id": str(uuid.uuid4()), "document_id": original["id"]})
        self.run_sql(f"set rastreadoc.document_operation={literal(context)};" + sql, actor=ACTOR, error="PT409")
        self.assertEqual(self.document(original["id"])["status"], "EN_OFICINA")
        self.assertEqual(self.movement_count(original["id"]), 1)

    def test_legacy_label_status_and_timestamp_updates_are_rejected(self):
        original = self.new_document()
        for assignment in ["label='Legacy correction'", "status='AUTORIZADO'", "last_movement_at=clock_timestamp()+interval '1 day'"]:
            with self.subTest(assignment=assignment):
                self.run_sql(f"update public.documents set {assignment} where id={literal(original['id'])};", actor=ACTOR, error="PT409")
                stored = self.document(original["id"])
                self.assertEqual(stored["label"], "Original")
                self.assertEqual(stored["status"], "EN_OFICINA")
                self.assertEqual(stored["last_movement_at"], original["last_movement_at"])
        self.assertEqual(self.movement_count(original["id"]), 1)

    def test_archive_and_restore_remain_available_to_existing_clients(self):
        original = self.new_document()
        self.run_sql(f"update public.documents set archived_at=clock_timestamp() where id={literal(original['id'])};", actor=ACTOR)
        self.assertIsNotNone(self.document(original["id"])["archived_at"])
        self.run_sql(f"update public.documents set archived_at=null where id={literal(original['id'])};", actor=ACTOR)
        self.assertIsNone(self.document(original["id"])["archived_at"])
        self.assertEqual(self.movement_count(original["id"]), 1)
        self.assertEqual(self.document(original["id"])["status"], "EN_OFICINA")

    def test_rpc_restores_context_after_success_in_the_same_transaction(self):
        for prior_context in ["", "caller-context"]:
            with self.subTest(prior_context=prior_context):
                original = self.new_document()
                sql = self.operation_sql(original, p_requested_status="ENVIADO", p_receipt_number="CONTEXT")
                sql = f"""
                  begin;
                  set local rastreadoc.document_operation={literal(prior_context)};
                  {sql}
                  select jsonb_build_object('context',current_setting('rastreadoc.document_operation',true));
                  do $guard$
                  begin
                    begin
                      insert into public.movements(document_id,status,created_by)
                      values ({literal(original['id'])}, 'AUTORIZADO', '{ACTOR}');
                      raise exception 'Legacy INSERT was allowed after RPC';
                    exception when sqlstate 'PT409' then null;
                    end;
                  end;
                  $guard$;
                  commit;
                """
                lines = self.run_sql(sql, actor=ACTOR).splitlines()
                self.assertEqual(json.loads(lines[-1])["context"], prior_context)
                self.assertEqual(self.document(original["id"])["status"], "ENVIADO")
                self.assertEqual(self.movement_count(original["id"]), 2)

    def test_rpc_restores_context_after_movement_failure_in_the_same_transaction(self):
        original = self.new_document()
        self.run_sql("""
          create function public.test_fail_context_movement() returns trigger language plpgsql as $$
          begin
            if new.notes = 'FORCE_CONTEXT_FAILURE' then
              raise sqlstate '23514' using message='Failure injected by isolated test';
            end if;
            return new;
          end; $$;
          create trigger test_context_failure before insert on public.movements
          for each row execute function public.test_fail_context_movement();
        """)
        try:
            sql = self.operation_sql(original, p_requested_status="ENVIADO", p_receipt_number="CONTEXT",
                                     p_notes="FORCE_CONTEXT_FAILURE")
            # PERFORM calls the RPC from a PL/pgSQL subtransaction so the
            # simulated request can inspect its context after catching failure.
            perform = sql.replace("select public.save_document_operation(", "perform public.save_document_operation(", 1)
            sql = f"""
              begin;
              set local rastreadoc.document_operation='caller-context';
              do $request$
              begin
                begin
                  {perform}
                  raise exception 'Injected failure did not occur';
                exception when sqlstate '23514' then null;
                end;
                if current_setting('rastreadoc.document_operation',true) <> 'caller-context' then
                  raise exception 'RPC leaked operation context after failure';
                end if;
                begin
                  insert into public.movements(document_id,status,created_by)
                  values ({literal(original['id'])}, 'AUTORIZADO', '{ACTOR}');
                  raise exception 'Legacy INSERT was allowed after failed RPC';
                exception when sqlstate 'PT409' then null;
                end;
              end;
              $request$;
              commit;
            """
            self.run_sql(sql, actor=ACTOR)
            self.assertEqual(self.document(original["id"])["status"], "EN_OFICINA")
            self.assertEqual(self.movement_count(original["id"]), 1)
        finally:
            self.run_sql("drop trigger test_context_failure on public.movements; drop function public.test_fail_context_movement();")

    def test_idempotency_is_independent_of_session_timezone(self):
        original = self.new_document()
        operation_id = str(uuid.uuid4())
        sql = self.operation_sql(original, operation_id, p_requested_status="ENVIADO", p_receipt_number="TZ")
        self.run_sql("set timezone='UTC';" + sql, actor=ACTOR)
        result = json.loads(self.run_sql("set timezone='America/Mexico_City';" + sql, actor=ACTOR))
        self.assertTrue(result["duplicate"])
        self.assertEqual(self.movement_count(original["id"]), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
