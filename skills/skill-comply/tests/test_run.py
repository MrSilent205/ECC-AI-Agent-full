"""Tests for the CLI's classification failure boundary."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from scripts import run
from scripts.classifier import ClassifierParseError
from scripts.parser import parse_spec, parse_trace

FIXTURES = Path(__file__).parent.parent / "fixtures"


@pytest.fixture
def cli(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> SimpleNamespace:
    skill = tmp_path / "fixture.md"
    skill.write_text("Read a file before editing it.\n")
    output = tmp_path / "report.md"
    spec = parse_spec(FIXTURES / "tdd_spec.yaml")
    observations = tuple(parse_trace(FIXTURES / "compliant_trace.jsonl"))
    scenarios = [
        SimpleNamespace(level_name=name, description="Controlled scenario")
        for name in ("supportive", "neutral")
    ]
    monkeypatch.setattr("sys.argv", ["skill-comply", str(skill), "--output", str(output)])
    monkeypatch.setattr(run, "__file__", str(tmp_path / "scripts" / "run.py"))
    monkeypatch.setattr(run, "generate_spec", Mock(return_value=spec))
    monkeypatch.setattr(run, "generate_scenarios", Mock(return_value=scenarios))
    execute = Mock(return_value=SimpleNamespace(observations=observations))
    monkeypatch.setattr(run, "run_scenario", execute)
    report = Mock(return_value="Controlled compliance report\n")
    monkeypatch.setattr(run, "generate_report", report)
    return SimpleNamespace(output=output, report=report, execute=execute)


@pytest.mark.parametrize("failure_index", [0, 1])
def test_classifier_failure_exits_without_report_or_raw_output(
    cli: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    failure_index: int,
) -> None:
    caplog.set_level("INFO")
    error = ClassifierParseError("raw-classifier-private-marker")
    results = [SimpleNamespace(compliance_rate=1.0)] * failure_index + [error]
    monkeypatch.setattr(run, "grade", Mock(side_effect=results))

    with pytest.raises(SystemExit) as exited:
        run.main()

    assert exited.value.code == 1
    assert "ClassifierParseError" in caplog.text
    assert "Classification failed" in caplog.text
    assert caplog.records[-1].message == (
        "ClassifierParseError: Classification failed; "
        "invalid classifier output. No report generated."
    )
    assert "raw-classifier-private-marker" not in caplog.text
    assert "Traceback" not in caplog.text
    assert "Overall Compliance" not in caplog.text
    assert not cli.output.exists()
    cli.report.assert_not_called()
    assert cli.execute.call_count == failure_index + 1


@pytest.mark.parametrize("error_type", [RuntimeError, ValueError, OSError])
def test_unrelated_grading_exception_propagates(
    cli: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
    error_type: type[Exception],
) -> None:
    error = error_type("unrelated failure")
    monkeypatch.setattr(run, "grade", Mock(side_effect=error))

    with pytest.raises(error_type) as raised:
        run.main()

    assert raised.value is error
    assert not cli.output.exists()
    cli.report.assert_not_called()


def test_classifier_error_outside_grading_propagates(cli: SimpleNamespace) -> None:
    error = ClassifierParseError("execution failure")
    cli.execute.side_effect = error

    with pytest.raises(ClassifierParseError) as raised:
        run.main()

    assert raised.value is error
    cli.report.assert_not_called()


def test_valid_positive_grading_writes_report(
    cli: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(run, "grade", Mock(return_value=SimpleNamespace(compliance_rate=1.0)))
    caplog.set_level("INFO")

    run.main()

    assert cli.output.read_text() == "Controlled compliance report\n"
    cli.report.assert_called_once()
    assert cli.execute.call_count == 2
    assert "Overall Compliance: 100%" in caplog.text
