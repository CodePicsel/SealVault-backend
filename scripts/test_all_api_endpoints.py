#!/usr/bin/env python3
"""
End-to-end API tester for SealVault backend.

Usage:
  python scripts/test_all_api_endpoints.py --pdf-path ./sample.pdf
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import http.cookiejar
import json
import os
import re
import sys
import traceback
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple


ALL_ENDPOINTS: Set[str] = {
    "POST /api/auth/register",
    "POST /api/auth/login",
    "POST /api/auth/google",
    "POST /api/auth/refresh",
    "POST /api/auth/logout",
    "GET /api/me",
    "POST /api/uploads/pdf",
    "GET /api/uploads",
    "GET /api/uploads/:id",
    "GET /api/uploads/:id/download",
    "POST /api/uploads/:id/signatures",
    "POST /api/uploads/:id/apply-signatures",
    "POST /api/signatures/upload",
    "GET /api/signatures",
    "POST /api/sign-requests",
    "GET /api/sign-requests/:requestId",
    "POST /api/sign-requests/:requestId/send-invites",
    "GET /api/signing/:inviteToken",
    "POST /api/signing/:inviteToken/sign",
    "GET /api/audit/:fileId",
    "POST /api/emails/files/:fileId/share",
}

TINY_PNG_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg=="
)


def now_iso_plus_days(days: int = 7) -> str:
    return (dt.datetime.utcnow() + dt.timedelta(days=days)).replace(microsecond=0).isoformat() + "Z"


def random_email(prefix: str) -> str:
    return f"{prefix}.{uuid.uuid4().hex[:10]}@example.com"


def safe_json_loads(text: str) -> Any:
    try:
        return json.loads(text)
    except Exception:
        return None


def encode_multipart(
    fields: Optional[Dict[str, str]] = None,
    files: Optional[List[Tuple[str, str, bytes, str]]] = None,
) -> Tuple[bytes, str]:
    boundary = f"----SealVaultBoundary{uuid.uuid4().hex}"
    chunks: List[bytes] = []

    for key, value in (fields or {}).items():
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(
            f'Content-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode("utf-8")
        )

    for field_name, filename, payload, content_type in (files or []):
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(
            (
                f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'
                f"Content-Type: {content_type}\r\n\r\n"
            ).encode("utf-8")
        )
        chunks.append(payload)
        chunks.append(b"\r\n")

    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


@dataclass
class HttpResponse:
    status: int
    text: str
    json: Any
    headers: Dict[str, str]


class HttpClient:
    def __init__(self, base_url: str, timeout: int = 30):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))

    def request(
        self,
        method: str,
        path: str,
        *,
        headers: Optional[Dict[str, str]] = None,
        json_body: Optional[Dict[str, Any]] = None,
        raw_body: Optional[bytes] = None,
    ) -> HttpResponse:
        url = self.base_url + path
        req_headers = dict(headers or {})
        data = None

        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            req_headers.setdefault("Content-Type", "application/json")
        elif raw_body is not None:
            data = raw_body

        req = urllib.request.Request(url=url, method=method.upper(), headers=req_headers, data=data)

        try:
            with self.opener.open(req, timeout=self.timeout) as resp:
                body = resp.read()
                text = body.decode("utf-8", errors="replace")
                return HttpResponse(
                    status=resp.getcode(),
                    text=text,
                    json=safe_json_loads(text),
                    headers={k.lower(): v for k, v in resp.headers.items()},
                )
        except urllib.error.HTTPError as err:
            body = err.read() if err.fp else b""
            text = body.decode("utf-8", errors="replace")
            return HttpResponse(
                status=err.code,
                text=text,
                json=safe_json_loads(text),
                headers={k.lower(): v for k, v in (err.headers.items() if err.headers else [])},
            )


@dataclass
class CaseResult:
    name: str
    endpoint_key: str
    status: Optional[int]
    expected: str
    passed: Optional[bool]
    note: str = ""


class ApiTestRunner:
    def __init__(self, stop_on_fail: bool = False):
        self.stop_on_fail = stop_on_fail
        self.results: List[CaseResult] = []
        self.covered: Set[str] = set()

    def _expected_to_text(self, expected: Iterable[int]) -> str:
        return ",".join(str(x) for x in sorted(set(expected)))

    def run_case(
        self,
        *,
        name: str,
        endpoint_key: str,
        client: HttpClient,
        method: str,
        path: str,
        expected_status: Iterable[int],
        headers: Optional[Dict[str, str]] = None,
        json_body: Optional[Dict[str, Any]] = None,
        raw_body: Optional[bytes] = None,
    ) -> HttpResponse:
        expected_set = set(expected_status)
        resp = client.request(
            method=method,
            path=path,
            headers=headers,
            json_body=json_body,
            raw_body=raw_body,
        )
        ok = resp.status in expected_set
        self.covered.add(endpoint_key)
        self.results.append(
            CaseResult(
                name=name,
                endpoint_key=endpoint_key,
                status=resp.status,
                expected=self._expected_to_text(expected_set),
                passed=ok,
                note="" if ok else (resp.text[:220] or "No response body"),
            )
        )
        mark = "PASS" if ok else "FAIL"
        print(f"[{mark}] {name}: {resp.status} (expected {self._expected_to_text(expected_set)})")
        if not ok:
            print(f"       {resp.text[:300]}")
            if self.stop_on_fail:
                raise RuntimeError(f"Stopping on failure: {name}")
        return resp

    def skip_case(self, name: str, endpoint_key: str, reason: str) -> None:
        self.results.append(
            CaseResult(
                name=name,
                endpoint_key=endpoint_key,
                status=None,
                expected="-",
                passed=None,
                note=reason,
            )
        )
        print(f"[SKIP] {name}: {reason}")

    def print_summary(self) -> int:
        total = len(self.results)
        passed = sum(1 for r in self.results if r.passed is True)
        failed = sum(1 for r in self.results if r.passed is False)
        skipped = sum(1 for r in self.results if r.passed is None)
        uncovered = sorted(ALL_ENDPOINTS - self.covered)

        print("\n=== TEST SUMMARY ===")
        print(f"Total cases: {total}")
        print(f"Passed:      {passed}")
        print(f"Failed:      {failed}")
        print(f"Skipped:     {skipped}")
        print(f"Endpoints covered: {len(self.covered)}/{len(ALL_ENDPOINTS)}")

        if uncovered:
            print("\nUncovered endpoints:")
            for ep in uncovered:
                print(f"  - {ep}")
        else:
            print("\nAll mounted endpoints were hit at least once.")

        if failed:
            print("\nFailed cases:")
            for r in self.results:
                if r.passed is False:
                    print(f"  - {r.name} ({r.endpoint_key}) -> status {r.status}, expected {r.expected}")
                    if r.note:
                        print(f"    {r.note}")
        return 1 if failed else 0


def auth_header(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def extract_token_from_mock_link(link: str) -> str:
    if not isinstance(link, str):
        return ""
    m = re.search(r"/sign/([^/?#]+)", link)
    return m.group(1) if m else ""


def load_pdf_bytes(path: str) -> bytes:
    with open(path, "rb") as fp:
        data = fp.read()
    if not data:
        raise ValueError("PDF file is empty")
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description="Run all backend API endpoint tests")
    parser.add_argument("--base-url", default="http://localhost:5000", help="API base URL")
    parser.add_argument("--pdf-path", required=True, help="Path to a real PDF file for upload tests")
    parser.add_argument("--owner-email", default="", help="Owner user email (optional)")
    parser.add_argument("--owner-password", default="s3cureP@ssw0rd", help="Owner user password")
    parser.add_argument("--secondary-email", default="", help="Secondary user email (optional)")
    parser.add_argument("--secondary-password", default="s3cureP@ssw0rd", help="Secondary user password")
    parser.add_argument("--invite-token1", default="", help="Manual signer-1 invite token (optional)")
    parser.add_argument("--invite-token2", default="", help="Manual signer-2 invite token (optional)")
    parser.add_argument("--stop-on-fail", action="store_true", help="Stop test run on first failure")
    parser.add_argument("--timeout", type=int, default=30, help="Request timeout in seconds")
    args = parser.parse_args()

    if not os.path.exists(args.pdf_path):
        print(f"PDF path not found: {args.pdf_path}", file=sys.stderr)
        return 2

    owner_email = args.owner_email or random_email("owner")
    secondary_email = args.secondary_email or random_email("secondary")
    signer1_email = random_email("signer1")
    signer2_email = random_email("signer2")
    signer1_name = "Signer One"
    signer2_name = "Signer Two"

    owner_client = HttpClient(args.base_url, timeout=args.timeout)
    secondary_client = HttpClient(args.base_url, timeout=args.timeout)
    public_client = HttpClient(args.base_url, timeout=args.timeout)
    runner = ApiTestRunner(stop_on_fail=args.stop_on_fail)

    ctx: Dict[str, Any] = {
        "owner_token": "",
        "secondary_token": "",
        "file_id": "",
        "signature_id": "",
        "sign_request_id": "",
        "invite_token1": args.invite_token1,
        "invite_token2": args.invite_token2,
        "audit_token": "",
    }

    signature_png = base64.b64decode(TINY_PNG_BASE64)
    sample_signature_data_url = f"data:image/png;base64,{TINY_PNG_BASE64}"
    pdf_bytes = load_pdf_bytes(args.pdf_path)

    try:
        runner.run_case(
            name="Auth register owner",
            endpoint_key="POST /api/auth/register",
            client=owner_client,
            method="POST",
            path="/api/auth/register",
            expected_status={201, 400},
            json_body={"email": owner_email, "password": args.owner_password},
        )
        resp = runner.run_case(
            name="Auth login owner",
            endpoint_key="POST /api/auth/login",
            client=owner_client,
            method="POST",
            path="/api/auth/login",
            expected_status={200},
            json_body={"email": owner_email, "password": args.owner_password},
        )
        ctx["owner_token"] = (resp.json or {}).get("token", "")

        runner.run_case(
            name="Auth register secondary",
            endpoint_key="POST /api/auth/register",
            client=secondary_client,
            method="POST",
            path="/api/auth/register",
            expected_status={201, 400},
            json_body={"email": secondary_email, "password": args.secondary_password},
        )
        resp = runner.run_case(
            name="Auth login secondary",
            endpoint_key="POST /api/auth/login",
            client=secondary_client,
            method="POST",
            path="/api/auth/login",
            expected_status={200},
            json_body={"email": secondary_email, "password": args.secondary_password},
        )
        ctx["secondary_token"] = (resp.json or {}).get("token", "")

        runner.run_case(
            name="Auth google invalid token",
            endpoint_key="POST /api/auth/google",
            client=owner_client,
            method="POST",
            path="/api/auth/google",
            expected_status={401},
            json_body={"id_token": "invalid-token"},
        )
        resp = runner.run_case(
            name="Auth refresh owner cookie flow",
            endpoint_key="POST /api/auth/refresh",
            client=owner_client,
            method="POST",
            path="/api/auth/refresh",
            expected_status={200},
        )
        refreshed = (resp.json or {}).get("token")
        if refreshed:
            ctx["owner_token"] = refreshed

        runner.run_case(
            name="Get /api/me",
            endpoint_key="GET /api/me",
            client=owner_client,
            method="GET",
            path="/api/me",
            expected_status={200},
            headers=auth_header(ctx["owner_token"]),
        )

        body, content_type = encode_multipart(
            files=[("file", os.path.basename(args.pdf_path), pdf_bytes, "application/pdf")]
        )
        resp = runner.run_case(
            name="Upload PDF",
            endpoint_key="POST /api/uploads/pdf",
            client=owner_client,
            method="POST",
            path="/api/uploads/pdf",
            expected_status={201},
            headers={**auth_header(ctx["owner_token"]), "Content-Type": content_type},
            raw_body=body,
        )
        ctx["file_id"] = (resp.json or {}).get("id", "")

        runner.run_case(
            name="List uploads",
            endpoint_key="GET /api/uploads",
            client=owner_client,
            method="GET",
            path="/api/uploads",
            expected_status={200},
            headers=auth_header(ctx["owner_token"]),
        )
        runner.run_case(
            name="Get uploaded file by id",
            endpoint_key="GET /api/uploads/:id",
            client=owner_client,
            method="GET",
            path=f"/api/uploads/{ctx['file_id']}",
            expected_status={200},
            headers=auth_header(ctx["owner_token"]),
        )
        runner.run_case(
            name="Get file download URL",
            endpoint_key="GET /api/uploads/:id/download",
            client=owner_client,
            method="GET",
            path=f"/api/uploads/{ctx['file_id']}/download",
            expected_status={200},
            headers=auth_header(ctx["owner_token"]),
        )

        body, content_type = encode_multipart(files=[("file", "signature.png", signature_png, "image/png")])
        resp = runner.run_case(
            name="Upload signature image",
            endpoint_key="POST /api/signatures/upload",
            client=owner_client,
            method="POST",
            path="/api/signatures/upload",
            expected_status={201},
            headers={**auth_header(ctx["owner_token"]), "Content-Type": content_type},
            raw_body=body,
        )
        ctx["signature_id"] = (resp.json or {}).get("id", "")

        runner.run_case(
            name="List signature images",
            endpoint_key="GET /api/signatures",
            client=owner_client,
            method="GET",
            path="/api/signatures",
            expected_status={200},
            headers=auth_header(ctx["owner_token"]),
        )
        runner.run_case(
            name="Place legacy signature on PDF",
            endpoint_key="POST /api/uploads/:id/signatures",
            client=owner_client,
            method="POST",
            path=f"/api/uploads/{ctx['file_id']}/signatures",
            expected_status={201},
            headers=auth_header(ctx["owner_token"]),
            json_body={"imageId": ctx["signature_id"], "page": 1, "xRel": 0.6, "yRel": 0.8, "widthRel": 0.2},
        )
        runner.run_case(
            name="Apply legacy signatures",
            endpoint_key="POST /api/uploads/:id/apply-signatures",
            client=owner_client,
            method="POST",
            path=f"/api/uploads/{ctx['file_id']}/apply-signatures",
            expected_status={201},
            headers=auth_header(ctx["owner_token"]),
        )

        resp = runner.run_case(
            name="Create sign request valid",
            endpoint_key="POST /api/sign-requests",
            client=owner_client,
            method="POST",
            path="/api/sign-requests",
            expected_status={201},
            headers=auth_header(ctx["owner_token"]),
            json_body={
                "fileId": ctx["file_id"],
                "title": "NDA - Vendor",
                "message": "Please sign by Friday",
                "expiresAt": now_iso_plus_days(7),
                "signers": [
                    {"name": signer1_name, "email": signer1_email, "order": 1},
                    {"name": signer2_name, "email": signer2_email, "order": 2},
                ],
                "fields": [
                    {"signerEmail": signer1_email, "page": 1, "xRel": 0.65, "yRel": 0.82, "widthRel": 0.22, "heightRel": 0.08, "required": True},
                    {"signerEmail": signer2_email, "page": 1, "xRel": 0.65, "yRel": 0.62, "widthRel": 0.22, "heightRel": 0.08, "required": True},
                ],
            },
        )
        ctx["sign_request_id"] = (resp.json or {}).get("id", "")

        runner.run_case(
            name="Create sign request invalid body",
            endpoint_key="POST /api/sign-requests",
            client=owner_client,
            method="POST",
            path="/api/sign-requests",
            expected_status={422},
            headers=auth_header(ctx["owner_token"]),
            json_body={
                "fileId": ctx["file_id"],
                "title": "Invalid",
                "message": "x",
                "expiresAt": now_iso_plus_days(7),
                "signers": [{"name": signer1_name, "email": signer1_email, "order": 1}],
                "fields": [{"signerEmail": signer1_email, "page": 1, "xRel": 1.2, "yRel": 0.4, "widthRel": 0.2}],
            },
        )

        runner.run_case(
            name="Get sign request by id",
            endpoint_key="GET /api/sign-requests/:requestId",
            client=owner_client,
            method="GET",
            path=f"/api/sign-requests/{ctx['sign_request_id']}",
            expected_status={200},
            headers=auth_header(ctx["owner_token"]),
        )
        runner.run_case(
            name="Get sign request by id forbidden",
            endpoint_key="GET /api/sign-requests/:requestId",
            client=secondary_client,
            method="GET",
            path=f"/api/sign-requests/{ctx['sign_request_id']}",
            expected_status={403},
            headers=auth_header(ctx["secondary_token"]),
        )

        resp = runner.run_case(
            name="Send invites",
            endpoint_key="POST /api/sign-requests/:requestId/send-invites",
            client=owner_client,
            method="POST",
            path=f"/api/sign-requests/{ctx['sign_request_id']}/send-invites",
            expected_status={200},
            headers=auth_header(ctx["owner_token"]),
        )
        for d in (resp.json or {}).get("deliveries", []):
            email = str(d.get("email", "")).lower()
            token = extract_token_from_mock_link(d.get("mockSigningLink", ""))
            if email == signer1_email.lower() and token:
                ctx["invite_token1"] = token
                ctx["audit_token"] = token
            if email == signer2_email.lower() and token:
                ctx["invite_token2"] = token

        runner.run_case(
            name="Send invites invalid requestId",
            endpoint_key="POST /api/sign-requests/:requestId/send-invites",
            client=owner_client,
            method="POST",
            path="/api/sign-requests/not-a-valid-object-id/send-invites",
            expected_status={422},
            headers=auth_header(ctx["owner_token"]),
        )
        runner.run_case(
            name="Send invites forbidden",
            endpoint_key="POST /api/sign-requests/:requestId/send-invites",
            client=secondary_client,
            method="POST",
            path=f"/api/sign-requests/{ctx['sign_request_id']}/send-invites",
            expected_status={403},
            headers=auth_header(ctx["secondary_token"]),
        )

        runner.run_case(
            name="Open signing link invalid token",
            endpoint_key="GET /api/signing/:inviteToken",
            client=public_client,
            method="GET",
            path="/api/signing/invalid-token-123",
            expected_status={404},
        )
        runner.run_case(
            name="Sign invalid token",
            endpoint_key="POST /api/signing/:inviteToken/sign",
            client=public_client,
            method="POST",
            path="/api/signing/invalid-token-123/sign",
            expected_status={404},
            json_body={"signatureImageBase64": sample_signature_data_url, "consent": True},
        )

        if ctx["invite_token1"] and ctx["invite_token2"]:
            runner.run_case(
                name="Open signer2 before turn",
                endpoint_key="GET /api/signing/:inviteToken",
                client=public_client,
                method="GET",
                path=f"/api/signing/{ctx['invite_token2']}",
                expected_status={200},
            )
            runner.run_case(
                name="Signer2 tries to sign out of order",
                endpoint_key="POST /api/signing/:inviteToken/sign",
                client=public_client,
                method="POST",
                path=f"/api/signing/{ctx['invite_token2']}/sign",
                expected_status={409},
                json_body={"signatureImageBase64": sample_signature_data_url, "consent": True},
            )
            runner.run_case(
                name="Open signer1 link",
                endpoint_key="GET /api/signing/:inviteToken",
                client=public_client,
                method="GET",
                path=f"/api/signing/{ctx['invite_token1']}",
                expected_status={200},
            )
            runner.run_case(
                name="Signer1 without consent",
                endpoint_key="POST /api/signing/:inviteToken/sign",
                client=public_client,
                method="POST",
                path=f"/api/signing/{ctx['invite_token1']}/sign",
                expected_status={422},
                json_body={"signatureImageBase64": sample_signature_data_url, "consent": False},
            )
            runner.run_case(
                name="Signer1 signs",
                endpoint_key="POST /api/signing/:inviteToken/sign",
                client=public_client,
                method="POST",
                path=f"/api/signing/{ctx['invite_token1']}/sign",
                expected_status={200},
                json_body={"signatureImageBase64": sample_signature_data_url, "consent": True},
            )
            runner.run_case(
                name="Signer1 reuse token",
                endpoint_key="POST /api/signing/:inviteToken/sign",
                client=public_client,
                method="POST",
                path=f"/api/signing/{ctx['invite_token1']}/sign",
                expected_status={410},
                json_body={"signatureImageBase64": sample_signature_data_url, "consent": True},
            )
            runner.run_case(
                name="Signer2 signs and finalizes",
                endpoint_key="POST /api/signing/:inviteToken/sign",
                client=public_client,
                method="POST",
                path=f"/api/signing/{ctx['invite_token2']}/sign",
                expected_status={200},
                json_body={"signatureImageBase64": sample_signature_data_url, "consent": True},
            )
        else:
            runner.skip_case(
                name="Full signing-flow token tests",
                endpoint_key="POST /api/signing/:inviteToken/sign",
                reason="Invite tokens unavailable. Configure mock mail mode or pass --invite-token1/2.",
            )

        runner.run_case(
            name="Audit by owner",
            endpoint_key="GET /api/audit/:fileId",
            client=owner_client,
            method="GET",
            path=f"/api/audit/{ctx['file_id']}",
            expected_status={200},
            headers=auth_header(ctx["owner_token"]),
        )
        runner.run_case(
            name="Audit by secondary no audit token",
            endpoint_key="GET /api/audit/:fileId",
            client=secondary_client,
            method="GET",
            path=f"/api/audit/{ctx['file_id']}",
            expected_status={401},
            headers=auth_header(ctx["secondary_token"]),
        )
        runner.run_case(
            name="Audit invalid x-audit-token",
            endpoint_key="GET /api/audit/:fileId",
            client=public_client,
            method="GET",
            path=f"/api/audit/{ctx['file_id']}",
            expected_status={403},
            headers={"x-audit-token": "invalid-audit-token"},
        )
        if ctx["audit_token"]:
            runner.run_case(
                name="Audit with signer token",
                endpoint_key="GET /api/audit/:fileId",
                client=public_client,
                method="GET",
                path=f"/api/audit/{ctx['file_id']}",
                expected_status={200},
                headers={"x-audit-token": ctx["audit_token"]},
            )
        else:
            runner.skip_case("Audit with signer token", "GET /api/audit/:fileId", "No signer audit token available.")

        runner.run_case(
            name="Audit invalid fileId",
            endpoint_key="GET /api/audit/:fileId",
            client=owner_client,
            method="GET",
            path="/api/audit/not-a-valid-object-id",
            expected_status={422},
            headers=auth_header(ctx["owner_token"]),
        )

        runner.run_case(
            name="Share original by owner",
            endpoint_key="POST /api/emails/files/:fileId/share",
            client=owner_client,
            method="POST",
            path=f"/api/emails/files/{ctx['file_id']}/share",
            expected_status={200},
            headers=auth_header(ctx["owner_token"]),
            json_body={"to": ["client@example.com"], "subject": "Original file", "message": "Please review", "version": "original"},
        )
        runner.run_case(
            name="Share final by owner",
            endpoint_key="POST /api/emails/files/:fileId/share",
            client=owner_client,
            method="POST",
            path=f"/api/emails/files/{ctx['file_id']}/share",
            expected_status={200, 409},
            headers=auth_header(ctx["owner_token"]),
            json_body={"to": ["client@example.com"], "subject": "Final signed file", "message": "Please review", "version": "final"},
        )
        runner.run_case(
            name="Share final by secondary forbidden",
            endpoint_key="POST /api/emails/files/:fileId/share",
            client=secondary_client,
            method="POST",
            path=f"/api/emails/files/{ctx['file_id']}/share",
            expected_status={403},
            headers=auth_header(ctx["secondary_token"]),
            json_body={"to": ["client@example.com"], "subject": "Forbidden test", "message": "Should fail", "version": "final"},
        )
        runner.run_case(
            name="Share invalid fileId",
            endpoint_key="POST /api/emails/files/:fileId/share",
            client=owner_client,
            method="POST",
            path="/api/emails/files/not-a-valid-object-id/share",
            expected_status={422},
            headers=auth_header(ctx["owner_token"]),
            json_body={"to": ["client@example.com"], "subject": "Invalid file id", "message": "Should fail", "version": "original"},
        )
        runner.run_case(
            name="Share without recipients",
            endpoint_key="POST /api/emails/files/:fileId/share",
            client=owner_client,
            method="POST",
            path=f"/api/emails/files/{ctx['file_id']}/share",
            expected_status={422},
            headers=auth_header(ctx["owner_token"]),
            json_body={"to": [], "subject": "No recipients", "message": "x", "version": "original"},
        )

        runner.run_case(
            name="Auth logout owner",
            endpoint_key="POST /api/auth/logout",
            client=owner_client,
            method="POST",
            path="/api/auth/logout",
            expected_status={200},
        )
        runner.run_case(
            name="Auth refresh after logout",
            endpoint_key="POST /api/auth/refresh",
            client=owner_client,
            method="POST",
            path="/api/auth/refresh",
            expected_status={401},
        )

    except Exception as exc:
        print("\nUnhandled test runner exception:", exc)
        traceback.print_exc()
        return 1

    return runner.print_summary()


if __name__ == "__main__":
    sys.exit(main())
