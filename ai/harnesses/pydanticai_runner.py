#!/usr/bin/env python3
"""JSONL PydanticAI sidecar for the local El Alamein rule bridge."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

@dataclass
class StepDeps:
    bridge_url: str
    bridge_token: str
    session_id: str
    action_attempts: list[dict[str, Any]] = field(default_factory=list)
    accepted_action: dict[str, Any] | None = None


def validate_profile(profile: dict[str, Any]) -> dict[str, Any]:
    tools = profile.get("tools") or []
    if "act" not in tools or any(name not in {"view_map", "act"} for name in tools):
        raise ValueError("pydanticai_harness supports only view_map and act profiles")
    if profile.get("parallel_tool_calls") is not False:
        raise ValueError("parallel_tool_calls must be false")
    return profile


def load_yaml_document(file: str) -> dict[str, Any]:
    try:
        import yaml
    except ImportError as error:
        raise RuntimeError("PyYAML is required to read the Agent configuration") from error
    document = yaml.safe_load(Path(file).read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise ValueError(f"{Path(file).name} must contain a YAML mapping")
    return document


def load_profile(profile_file: str, profile_id: str) -> dict[str, Any]:
    document = load_yaml_document(profile_file)
    profiles = document.get("tool_profiles", document)
    profile = profiles[profile_id]
    return validate_profile(profile)


def load_tool_definitions(catalog_file: str, profile: dict[str, Any]) -> dict[str, dict[str, Any]]:
    catalog = load_yaml_document(catalog_file).get("tools", {})
    definitions = {name: catalog[name] for name in profile["tools"]}
    for name, definition in definitions.items():
        if (
            definition.get("name") != name
            or not definition.get("description")
            or not definition.get("parameters")
        ):
            raise ValueError(f"invalid tool definition {name}")
    return definitions


def usage_dict(result: Any) -> dict[str, int]:
    usage = result.usage
    usage = usage() if callable(usage) else usage
    return {
        "requests": int(getattr(usage, "requests", 0)),
        "tool_calls": int(getattr(usage, "tool_calls", 0)),
        "input_tokens": int(getattr(usage, "input_tokens", 0)),
        "output_tokens": int(getattr(usage, "output_tokens", 0)),
        "cache_read_tokens": int(getattr(usage, "cache_read_tokens", 0)),
        "cache_write_tokens": int(getattr(usage, "cache_write_tokens", 0)),
    }


def pydanticai_dependencies() -> tuple[Any, ...]:
    try:
        import httpx
        from openai import AsyncOpenAI
        from pydantic_ai import Agent, RunContext
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.deepseek import DeepSeekProvider
        from pydantic_ai.providers.openai import OpenAIProvider
        from pydantic_ai.usage import UsageLimits
        # PydanticAI resolves deferred tool annotations from module globals.
        # Keep the protocol-check path dependency-free while making the real
        # Agent's RunContext annotation discoverable once dependencies load.
        globals()["RunContext"] = RunContext
        return httpx, AsyncOpenAI, Agent, RunContext, OpenAIChatModel, DeepSeekProvider, OpenAIProvider, UsageLimits
    except ImportError as error:
        raise RuntimeError(
            "PydanticAI dependencies are not installed. Use a Python 3.11+ environment with pyproject.toml installed."
        ) from error


def build_model(args: argparse.Namespace) -> Any:
    (
        _httpx,
        AsyncOpenAI,
        _Agent,
        _RunContext,
        OpenAIChatModel,
        DeepSeekProvider,
        OpenAIProvider,
        _UsageLimits,
    ) = pydanticai_dependencies()
    client = AsyncOpenAI(base_url=args.gateway_url, api_key=args.gateway_token)
    provider = (
        DeepSeekProvider(openai_client=client)
        if args.provider == "deepseek"
        else OpenAIProvider(openai_client=client)
    )
    return OpenAIChatModel(args.model, provider=provider)


def build_agent(args: argparse.Namespace, profile: dict[str, Any], tool_definitions: dict[str, dict[str, Any]]) -> Any:
    httpx, _AsyncOpenAI, Agent, RunContext, _OpenAIChatModel, _DeepSeekProvider, _OpenAIProvider, _UsageLimits = pydanticai_dependencies()
    model = build_model(args)
    if not args.agent_instructions:
        raise ValueError("agent instructions must be supplied by the prompt registry owner")
    agent: Agent[StepDeps, str] = Agent(
        model,
        deps_type=StepDeps,
        output_type=str,
        name="wargame",
        retries=max(0, args.max_attempts - 1),
        instructions=args.agent_instructions,
    )

    async def call_bridge(ctx: RunContext[StepDeps], name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=args.bridge_timeout_seconds) as client:
            response = await client.post(
                f"{ctx.deps.bridge_url}/tool",
                headers={"authorization": f"Bearer {ctx.deps.bridge_token}"},
                json={"tool": name, "arguments": arguments, "session_id": ctx.deps.session_id},
            )
        try:
            result = response.json()
        except json.JSONDecodeError:
            result = {"accepted": False, "reason": f"rule bridge returned status {response.status_code}"}
        if not response.is_success:
            result = {"accepted": False, "retryable": False, "reason": result.get("error", f"rule bridge status {response.status_code}")}
        return result

    if "view_map" in profile["tools"]:
        async def view_map(ctx: RunContext[StepDeps], focus: str = "overview", target: str | None = None) -> dict[str, Any]:
            arguments: dict[str, Any] = {"focus": focus}
            if target:
                arguments["target"] = target
            return await call_bridge(ctx, "view_map", arguments)
        view_map.__doc__ = tool_definitions["view_map"]["description"]
        agent.tool(view_map)

    async def act(ctx: RunContext[StepDeps], action: dict[str, Any]) -> dict[str, Any]:
        result = await call_bridge(ctx, "act", {"action": action})
        ctx.deps.action_attempts.append({
            "attempt": len(ctx.deps.action_attempts) + 1,
            "action": action,
            "accepted": bool(result.get("accepted")),
            "reason": result.get("reason", ""),
            "issues": result.get("issues", []),
            "assessment": result.get("assessment"),
        })
        if result.get("accepted"):
            ctx.deps.accepted_action = result.get("action") or result.get("canonical_action")
        return result
    act.__doc__ = tool_definitions["act"]["description"]
    agent.tool(act)

    return agent


async def handle_step(agent: Any, payload: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    deps = StepDeps(
        bridge_url=args.bridge_url,
        bridge_token=args.bridge_token,
        session_id=str(payload["session_id"]),
    )
    try:
        _httpx, _AsyncOpenAI, _Agent, _RunContext, _OpenAIChatModel, _DeepSeekProvider, _OpenAIProvider, UsageLimits = pydanticai_dependencies()
        result = await agent.run(
            str(payload["prompt"]),
            deps=deps,
            model_settings={"temperature": args.temperature, "max_tokens": args.output_limit, "parallel_tool_calls": False},
            usage_limits=UsageLimits(request_limit=args.max_attempts, tool_calls_limit=args.max_attempts),
        )
        return {
            "type": "step_result",
            "step": payload.get("step"),
            "accepted": deps.accepted_action is not None,
            "final_action": deps.accepted_action,
            "action_attempts": deps.action_attempts,
            "model_output": str(result.output),
            "usage": usage_dict(result),
            "error": None,
        }
    except Exception as error:  # The Node owner performs the deterministic fallback.
        return {
            "type": "step_result",
            "step": payload.get("step"),
            "accepted": deps.accepted_action is not None,
            "final_action": deps.accepted_action,
            "action_attempts": deps.action_attempts,
            "model_output": "",
            "usage": {},
            "error": str(error),
        }


async def async_main(args: argparse.Namespace) -> int:
    profile = validate_profile(json.loads(args.tool_profile_json)) if args.tool_profile_json else load_profile(args.tool_profile_file, args.tool_profile)
    tool_definitions = load_tool_definitions(args.tool_catalog_file, profile)
    if args.protocol_check:
        print(json.dumps({
            "ok": True,
            "tool_profile": profile["id"],
            "allowed_tools": profile["tools"],
            "tool_descriptions": {name: definition["description"] for name, definition in tool_definitions.items()},
        }), flush=True)
        return 0
    if args.dependency_check:
        pydanticai_dependencies()
        print(json.dumps({"ok": True, "dependencies": "pydantic_ai", "tool_profile": profile["id"]}), flush=True)
        return 0
    agent = build_agent(args, profile, tool_definitions)
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            return 0
        try:
            payload = json.loads(line)
            if payload.get("type") == "close":
                print(json.dumps({"type": "closed"}), flush=True)
                return 0
            if payload.get("type") != "step":
                raise ValueError("expected type=step")
            result = await handle_step(agent, payload, args)
        except Exception as error:
            result = {"type": "step_result", "accepted": False, "final_action": None, "action_attempts": [], "usage": {}, "error": str(error)}
        print(json.dumps(result, ensure_ascii=True), flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--provider", default="openai_compatible")
    parser.add_argument("--gateway-url", required=True)
    parser.add_argument("--gateway-token", required=True)
    parser.add_argument("--bridge-url", required=True)
    parser.add_argument("--bridge-token", required=True)
    parser.add_argument("--tool-profile", default="map_and_action")
    parser.add_argument("--tool-profile-file", default=str(Path(__file__).resolve().parents[1] / "config" / "agent_methods.yaml"))
    parser.add_argument("--tool-catalog-file", default=str(Path(__file__).resolve().parents[1] / "config" / "agent_tools.yaml"))
    parser.add_argument("--tool-profile-json", default="")
    parser.add_argument("--agent-instructions", default="")
    parser.add_argument("--max-attempts", type=int, default=6)
    parser.add_argument("--temperature", type=float, default=0.25)
    parser.add_argument("--output-limit", type=int, default=6000)
    parser.add_argument("--bridge-timeout-seconds", type=float, default=30)
    parser.add_argument("--protocol-check", action="store_true")
    parser.add_argument("--dependency-check", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(async_main(parse_args())))
    except KeyboardInterrupt:
        raise SystemExit(130)
