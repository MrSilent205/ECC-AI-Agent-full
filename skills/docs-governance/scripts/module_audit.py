"""Read-only evidence discovery for explicitly selected business modules."""

from pathlib import Path


def carrier_candidates(root: Path, module: Path, name: str, mapped: str) -> list[Path]:
    directories = [module, *module.parents]
    directories = directories[:directories.index(root)]
    candidates = [directory / name for directory in directories] + [root / mapped]
    return list(dict.fromkeys(candidates))


def check_modules(root, roles, names, report, resolve_source, read_source, check_links):
    """Use the audit's existing containment, UTF-8 and Markdown checks unchanged."""
    report.section("modules")
    sources = set()
    for name in sorted(set(names)):
        requested = Path(name)
        module = resolve_source(root, root / requested)
        if requested.is_absolute() or module is None or not module.is_dir():
            report.fail(
                f"Module must be a repository-relative directory inside root: {name!r}"
            )
            continue
        report.ok(f"Selected module: {str(module.relative_to(root))!r}")
        for role, filename in (("agents", "AGENTS.md"), ("context", "CONTEXT.md")):
            found = False
            for candidate in carrier_candidates(root, module, filename, roles[role]):
                if not candidate.exists() and not candidate.is_symlink():
                    continue
                resolved = resolve_source(root, candidate)
                if resolved is None or not resolved.is_file():
                    report.fail(
                        f"Module {role} source must be a repository-contained regular file: "
                        f"{str(candidate.relative_to(root))!r}"
                    )
                    found = True
                    break
                if read_source(resolved, report, f"module {role} source") is None:
                    found = True
                    break
                sources.add(resolved)
                source_label = str(candidate.relative_to(root))
                if candidate.parent == module:
                    report.ok(f"Local {role} source: {source_label!r}")
                else:
                    report.warn(
                        f"Shared {role} candidate: {source_label!r}; "
                        f"confirm it covers module {str(module.relative_to(root))!r}"
                    )
                found = True
                break
            if not found:
                report.warn(
                    f"No {role} source found for module {str(module.relative_to(root))!r}; "
                    "review existing rules or glossary before creating a file"
                )
    check_links(root, sorted(sources), report, skip_templates=False)
    report.warn(
        "Module responsibilities, instruction loading, terminology and code/contract "
        "consistency require semantic review; file presence is not proof of coverage"
    )
