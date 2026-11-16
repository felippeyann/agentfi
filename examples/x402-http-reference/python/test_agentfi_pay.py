"""Tests for agentfi_pay.py (stdlib unittest, localhost only):  python -m unittest -v test_agentfi_pay"""
import json
import socket
import threading
import unittest

from agentfi_pay import pay_resource


class RawServer:
    """A raw TCP "API": answers one request with the given bytes, then closes (mid-body if short)."""

    def __init__(self, raw: bytes):
        self.raw = raw
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        conn, _ = self.sock.accept()
        conn.settimeout(3)
        try:
            conn.recv(65536)
            conn.sendall(self.raw)
            conn.shutdown(socket.SHUT_WR)  # clean FIN after the (possibly short) body; no RST
            conn.settimeout(0.5)
            try:
                conn.recv(1)
            except OSError:
                pass
        except OSError:
            pass
        finally:
            conn.close()
            self.sock.close()


def http200(body: str, extra: int = 0) -> bytes:
    b = body.encode()
    return (f"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len(b) + extra}\r\nConnection: close\r\n\r\n").encode() + b


def run(raw: bytes):
    s = RawServer(raw)
    return pay_resource(f"http://127.0.0.1:{s.port}", "agfi_stub_not_a_secret", "job_1", "https://seller.example/r",
                        payment_id="py-test-payment-000001", timeout=3)


def settled(resource) -> str:
    return json.dumps({"payment": {"status": "settled", "amount": "300000"}, "remainingBudget": {}, "resource": resource})


class PayResourceTests(unittest.TestCase):
    def test_p1_incomplete_body_then_disconnect_is_unknown_not_free(self):
        r = run(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 500\r\nConnection: close\r\n\r\n" + b'{"payment": {"sta')
        self.assertEqual(r.outcome, "outcome_unknown")
        self.assertFalse(r.new_payment_id_allowed)
        self.assertEqual(r.http_status, 200)
        self.assertIn("Do not retry with a new payment_id", r.advice)

    def test_p1_invalid_json_is_unknown(self):
        r = run(http200("not json at all"))
        self.assertEqual(r.outcome, "outcome_unknown")
        self.assertFalse(r.new_payment_id_allowed)

    def test_p1_missing_payment_is_uncertain_only_explicit_null_is_free(self):
        missing = run(http200("{}"))
        self.assertEqual(missing.outcome, "outcome_unknown")
        self.assertFalse(missing.new_payment_id_allowed)
        free = run(http200(json.dumps({"payment": None, "remainingBudget": {}, "resource": {"status": 200}})))
        self.assertEqual(free.outcome, "free_resource")

    def test_p2_settled_with_seller_http_error_is_not_delivered(self):
        for status in (404, 500, 502):
            r = run(http200(settled({"status": status, "body": "oops"})))
            self.assertEqual(r.outcome, "settled_not_delivered", status)
            self.assertFalse(r.new_payment_id_allowed)
            self.assertNotIn("Paid and delivered", r.advice)
            self.assertIn("NOT delivered", r.advice)

    def test_p2_settled_delivered_and_partial(self):
        self.assertEqual(run(http200(settled({"status": 200, "body": {}}))).outcome, "settled")
        self.assertEqual(run(http200(settled({"status": 200, "body": "x", "truncated": True}))).outcome, "settled_partial_delivery")


if __name__ == "__main__":
    unittest.main()
