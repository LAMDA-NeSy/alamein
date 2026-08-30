import json
import subprocess
import sys
from argparse import Namespace
from pathlib import Path

from ai.harnesses.pydanticai_runner import build_model


ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "ai" / "harnesses" / "pydanticai_runner.py"


def test_runner_accepts_the_map_and_action_profile():
    result = subprocess.run(
        [
            sys.executable,
            str(RUNNER),
            "--model", "mock-wargame-primary",
            "--gateway-url", "http://127.0.0.1:1/v1",
            "--gateway-token", "test",
            "--bridge-url", "http://127.0.0.1:1",
            "--bridge-token", "test",
            "--protocol-check",
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    assert payload["tool_profile"] == "map_and_action"
    assert payload["allowed_tools"] == ["view_map", "act"]
    assert "current board" in payload["tool_descriptions"]["view_map"]
    assert "authoritative rules engine" in payload["tool_descriptions"]["act"]


def test_runner_keeps_the_single_action_baseline():
    result = subprocess.run(
        [
            sys.executable,
            str(RUNNER),
            "--model", "mock-wargame-primary",
            "--gateway-url", "http://127.0.0.1:1/v1",
            "--gateway-token", "test",
            "--bridge-url", "http://127.0.0.1:1",
            "--bridge-token", "test",
            "--tool-profile", "single_action",
            "--protocol-check",
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    assert payload["allowed_tools"] == ["act"]


def test_deepseek_provider_preserves_reasoning_content_for_tool_round_trips():
    model = build_model(Namespace(
        model="deepseek-v4-flash",
        provider="deepseek",
        gateway_url="http://127.0.0.1:1/v1",
        gateway_token="temporary-local-token",
    ))
    assert model.profile.openai_chat_thinking_field == "reasoning_content"
    assert model.profile.openai_chat_send_back_thinking_parts == "field"
