import argparse
import json
import os
import subprocess
import sys
import time
from typing import List, Optional

import requests
from dotenv import load_dotenv


def _wait_for_health(base_url: str, timeout_seconds: int) -> bool:
    deadline = time.time() + timeout_seconds
    health_url = f"{base_url.rstrip('/')}/"

    while time.time() < deadline:
        try:
            response = requests.get(health_url, timeout=3)
            if response.status_code == 200:
                return True
        except requests.RequestException:
            pass
        time.sleep(1)

    return False


def _start_server(port: int) -> subprocess.Popen:
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _sanitize_env_check() -> Optional[str]:
    if not os.getenv("GEMINI_API_KEY"):
        return "GEMINI_API_KEY is missing in environment/.env"
    return None


def _call_run_endpoint(base_url: str, pdf_url: str, questions: List[str], timeout_seconds: int) -> dict:
    endpoint = f"{base_url.rstrip('/')}/hackrx/run"
    payload = {
        "documents": pdf_url,
        "questions": questions,
    }

    response = requests.post(endpoint, json=payload, timeout=timeout_seconds)
    response.raise_for_status()
    return response.json()


def _validate_result(data: dict, question_count: int) -> Optional[str]:
    if "answers" not in data:
        return "Response does not contain 'answers'"
    if not isinstance(data["answers"], list):
        return "'answers' is not a list"
    if len(data["answers"]) != question_count:
        return "Number of answers does not match number of questions"
    if any("LLM call failed" in str(ans) for ans in data["answers"]):
        return "LLM invocation failed for at least one answer"
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test for HackRx API")
    parser.add_argument(
        "--base-url",
        default="http://127.0.0.1:8000",
        help="API base URL",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Port used only when auto-starting uvicorn",
    )
    parser.add_argument(
        "--pdf-url",
        default="https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
        help="Public PDF URL to test with",
    )
    parser.add_argument(
        "--question",
        action="append",
        default=["What does this document contain?"],
        help="Question to ask (repeat flag for multiple questions)",
    )
    parser.add_argument(
        "--startup-timeout",
        type=int,
        default=60,
        help="Seconds to wait for API startup",
    )
    parser.add_argument(
        "--request-timeout",
        type=int,
        default=180,
        help="Seconds to wait for /hackrx/run response",
    )
    parser.add_argument(
        "--keep-server",
        action="store_true",
        help="Do not stop server if this script started it",
    )
    parser.add_argument(
        "--health-only",
        action="store_true",
        help="Only validate health endpoint",
    )
    parser.add_argument(
        "--no-cache-bust",
        action="store_true",
        help="Keep questions unchanged (default appends unique token to bypass answer cache)",
    )

    args = parser.parse_args()

    load_dotenv()
    env_error = _sanitize_env_check()
    if env_error:
        print(f"FAIL: {env_error}")
        return 1

    server_started_by_script = False
    server_process: Optional[subprocess.Popen] = None

    try:
        if not _wait_for_health(args.base_url, 2):
            server_process = _start_server(args.port)
            server_started_by_script = True

        if not _wait_for_health(args.base_url, args.startup_timeout):
            print("FAIL: API did not become healthy in time")
            return 1

        print("PASS: Health endpoint is reachable")

        if args.health_only:
            return 0

        questions = list(args.question)
        if not args.no_cache_bust:
            token = f" [smoke-token:{int(time.time())}]"
            questions = [q + token for q in questions]

        start = time.time()
        result = _call_run_endpoint(
            base_url=args.base_url,
            pdf_url=args.pdf_url,
            questions=questions,
            timeout_seconds=args.request_timeout,
        )
        elapsed = time.time() - start

        validation_error = _validate_result(result, len(questions))
        if validation_error:
            print(f"FAIL: {validation_error}")
            print("Response snapshot:")
            print(json.dumps(result, indent=2)[:1000])
            return 1

        print(f"PASS: /hackrx/run responded correctly in {elapsed:.2f}s")
        preview_answers = [str(a)[:160] for a in result["answers"]]
        print("Answer preview:")
        print(json.dumps(preview_answers, indent=2))
        return 0

    except requests.HTTPError as exc:
        detail = exc.response.text[:500] if exc.response is not None else str(exc)
        print(f"FAIL: HTTP error calling API: {detail}")
        return 1
    except requests.RequestException as exc:
        print(f"FAIL: Request error: {exc}")
        return 1
    except Exception as exc:
        print(f"FAIL: Unexpected error: {exc}")
        return 1
    finally:
        if server_started_by_script and server_process and not args.keep_server:
            server_process.terminate()
            try:
                server_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server_process.kill()


if __name__ == "__main__":
    raise SystemExit(main())
