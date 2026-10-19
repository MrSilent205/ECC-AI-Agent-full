from types import SimpleNamespace
from typing import Any

import pytest

from llm.core.types import LLMInput, Message, Role, ToolCall, ToolDefinition
from llm.providers.claude import ClaudeProvider
from llm.tools import ReActAgent, ToolExecutor, ToolRegistry


class FakeMessages:
    def __init__(self, response: SimpleNamespace) -> None:
        self.response = response
        self.last_params: dict[str, Any] = {}

    def create(self, **params: object) -> SimpleNamespace:
        self.last_params = dict(params)
        return self.response


class FakeClient:
    def __init__(self, response: SimpleNamespace) -> None:
        self.messages = FakeMessages(response)
        self.api_key = "test-key"


def make_provider(response: SimpleNamespace) -> ClaudeProvider:
    provider = ClaudeProvider(api_key="test-key")
    provider.client = FakeClient(response)
    return provider


def make_response(content: list[SimpleNamespace], stop_reason: str = "tool_use") -> SimpleNamespace:
    return SimpleNamespace(
        content=content,
        model="claude-test",
        usage=SimpleNamespace(input_tokens=3, output_tokens=5),
        stop_reason=stop_reason,
    )


@pytest.mark.unit
@pytest.mark.parametrize(
    ("default_model", "request_model", "expected_model"),
    [
        (None, None, "claude-sonnet-4-6"),
        (None, "claude-haiku-4-5", "claude-haiku-4-5"),
        ("claude-haiku-4-5", None, "claude-haiku-4-5"),
        ("claude-opus-4-8", None, "claude-opus-4-8"),
        ("claude-haiku-4-5", "claude-opus-4-8", "claude-opus-4-8"),
    ],
)
def test_generate_respects_configured_default_and_request_model(
    default_model: str | None, request_model: str | None, expected_model: str
) -> None:
    provider_options = {"api_key": "test-key"}
    if default_model is not None:
        provider_options["default_model"] = default_model
    provider = ClaudeProvider(**provider_options)
    client = FakeClient(make_response([SimpleNamespace(type="text", text="ok")]))
    provider.client = client
    expected_default = default_model or "claude-sonnet-4-6"

    assert provider.get_default_model() == expected_default

    provider.generate(
        LLMInput(messages=[Message(role=Role.USER, content="Hi")], model=request_model)
    )

    assert client.messages.last_params["model"] == expected_model
    if expected_model == "claude-opus-4-8":
        assert client.messages.last_params["thinking"] == {"type": "adaptive"}
        assert "temperature" not in client.messages.last_params
    assert provider.get_default_model() == expected_default


@pytest.mark.unit
def test_generate_collects_text_and_tool_use_blocks() -> None:
    provider = make_provider(
        make_response(
            [
                SimpleNamespace(type="text", text="I will search. "),
                SimpleNamespace(type="tool_use", id="toolu_1", name="search", input={"query": "claude"}),
                SimpleNamespace(type="text", text="Done."),
            ]
        )
    )

    output = provider.generate(LLMInput(messages=[Message(role=Role.USER, content="Search")]))

    assert output.content == "I will search. Done."
    assert output.tool_calls is not None
    assert len(output.tool_calls) == 1
    assert output.tool_calls[0].id == "toolu_1"
    assert output.tool_calls[0].name == "search"
    assert output.tool_calls[0].arguments == {"query": "claude"}


@pytest.mark.unit
def test_generate_collects_multiple_tool_use_blocks() -> None:
    provider = make_provider(
        make_response(
            [
                SimpleNamespace(type="tool_use", id="toolu_1", name="search", input={"query": "claude"}),
                SimpleNamespace(
                    type="tool_use",
                    id="toolu_2",
                    name="read",
                    input=SimpleNamespace(path="README.md"),
                ),
            ]
        )
    )

    output = provider.generate(LLMInput(messages=[Message(role=Role.USER, content="Use tools")]))

    assert output.content == ""
    assert [call.id for call in output.tool_calls or []] == ["toolu_1", "toolu_2"]
    assert (output.tool_calls or [])[1].arguments == {"path": "README.md"}


@pytest.mark.unit
def test_generate_copies_tool_use_dict_arguments() -> None:
    raw_arguments: dict[str, Any] = {"query": "claude"}
    provider = make_provider(
        make_response(
            [SimpleNamespace(type="tool_use", id="toolu_1", name="search", input=raw_arguments)]
        )
    )

    output = provider.generate(LLMInput(messages=[Message(role=Role.USER, content="Use tools")]))
    raw_arguments["query"] = "mutated"

    assert (output.tool_calls or [])[0].arguments == {"query": "claude"}


@pytest.mark.unit
def test_generate_text_only_has_no_tool_calls() -> None:
    provider = make_provider(
        make_response(
            [SimpleNamespace(type="text", text="Hello.")],
            stop_reason="end_turn",
        )
    )

    output = provider.generate(LLMInput(messages=[Message(role=Role.USER, content="Hi")]))

    assert output.content == "Hello."
    assert output.tool_calls is None


@pytest.mark.unit
def test_generate_does_not_pass_cache_control_as_top_level_param() -> None:
    # cache_control is a per-content-block field on the Anthropic Messages API,
    # not a top-level parameter. Passing it at the top level raises TypeError
    # in the Anthropic Python SDK (or a 400 from the API).
    provider = make_provider(make_response([SimpleNamespace(type="text", text="ok")]))

    provider.generate(
        LLMInput(
            messages=[
                Message(role=Role.SYSTEM, content="system prompt"),
                Message(role=Role.USER, content="hi"),
            ]
        )
    )

    params = provider.client.messages.last_params
    assert "cache_control" not in params

    # When a system prompt is present, cache_control should ride on the last
    # system content block so ephemeral prompt caching still works.
    system = params.get("system")
    assert isinstance(system, list), "system should be sent as a list of content blocks"
    assert system, "system content-block list should not be empty"
    assert system[-1].get("cache_control") == {"type": "ephemeral"}


@pytest.mark.unit
def test_generate_without_system_does_not_set_system_or_cache_control() -> None:
    provider = make_provider(make_response([SimpleNamespace(type="text", text="ok")]))

    provider.generate(LLMInput(messages=[Message(role=Role.USER, content="hi")]))

    params = provider.client.messages.last_params
    assert "cache_control" not in params
    assert "system" not in params


@pytest.mark.unit
async def test_agent_round_trip_uses_anthropic_tool_blocks() -> None:
    provider = make_provider(make_response([
        SimpleNamespace(type="tool_use", id="toolu_1", name="lookup", input={"key": "a"}),
        SimpleNamespace(type="tool_use", id="toolu_2", name="lookup", input={"key": "b"}),
    ]))
    registry = ToolRegistry()
    registry.register(
        ToolDefinition(name="lookup", description="Lookup", parameters={"type": "object"}),
        lambda key: f"value:{key}",
    )
    messages_api = provider.client.messages
    original_create = messages_api.create
    calls = []

    def create(**params):
        calls.append(params)
        if len(calls) == 2:
            messages_api.response = make_response([SimpleNamespace(type="text", text="Done")])
        return original_create(**params)

    messages_api.create = create
    output = await ReActAgent(provider, ToolExecutor(registry)).run(
        LLMInput(messages=[Message(role=Role.USER, content="Look up a and b")], tools=registry.list_tools())
    )

    assert output.content == "Done"
    assert calls[1]["messages"] == [
        {"role": "user", "content": "Look up a and b"},
        {"role": "assistant", "content": [
            {"type": "tool_use", "id": "toolu_1", "name": "lookup", "input": {"key": "a"}},
            {"type": "tool_use", "id": "toolu_2", "name": "lookup", "input": {"key": "b"}},
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": "value:a"},
            {"type": "tool_result", "tool_use_id": "toolu_2", "content": "value:b"},
        ]},
    ]


@pytest.mark.unit
def test_generate_preserves_text_alongside_tool_calls() -> None:
    provider = make_provider(make_response([SimpleNamespace(type="text", text="Done")]))
    provider.generate(LLMInput(messages=[Message(
        role=Role.ASSISTANT,
        content="Checking",
        name="assistant-name",
        tool_calls=[ToolCall(id="toolu_1", name="lookup", arguments={})],
    )]))
    assert provider.client.messages.last_params["messages"] == [{
        "role": "assistant",
        "content": [
            {"type": "text", "text": "Checking"},
            {"type": "tool_use", "id": "toolu_1", "name": "lookup", "input": {}},
        ],
    }]


@pytest.mark.unit
def test_generate_rejects_tool_results_without_call_id() -> None:
    provider = make_provider(make_response([]))
    with pytest.raises(ValueError, match="tool_call_id"):
        provider.generate(LLMInput(messages=[Message(role=Role.TOOL, content="result")]))
