# Project Context

## What this is

A general-purpose tool that deterministically distributes shared reference documents to the
skills of a skill repository and guarantees that each distributed copy is identical to its
canonical source. Those two responsibilities — distribution and identity assurance — are the
whole scope: compatibility judgment and regression detection belong to the consuming
repository's own regression machinery, not to this tool. The tool is not locked to any
particular repository; [agentic-meta](https://github.com/ba0918/agentic-meta) is the first
intended consumer, whose Python vendor machinery this tool's v1 is designed to replace.

## Stack and layout

Deno/TypeScript (Deno pinned to the 2.9.x line in CI). The tool ships as a single `.ts`
source file that consumers sync at a fixed digest and run with `deno run` — no `deno compile`
binary distribution.

| Path | What it holds |
|---|---|
| `docs/spec/` | Design decisions (Japanese) |
| `.github/workflows/ci.yml` | CI: `deno task test` on Deno 2.9.x |

## Commands

| Purpose | Command |
|---|---|
| Test | `deno task test` |
| Lint | `deno task lint` |
| Format | `deno task fmt` |
| Format check | `deno task fmt:check` |

## Conventions specific to this project

- Language: `docs/spec/` is written in Japanese; everything else is written in English (the
  same convention as the sister repositories).

## Constraints

## Glossary
