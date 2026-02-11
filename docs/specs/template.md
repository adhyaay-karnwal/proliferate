# [Subsystem Name] — System Spec

## 1. Scope & Purpose

### In Scope
- [What this subsystem owns]
- [Boundaries it enforces]

### Out of Scope
- [Adjacent systems this does NOT own — helps agents know when to stop]

### Mental Model

_1-4 paragraphs: why this exists, how to reason about it, the core abstraction._

**Core entities:**
- **[Entity A]** — _what it represents, who owns its lifecycle_
- **[Entity B]** — _how it relates to Entity A_

**Key invariants:**
- _Rules that must always hold_
- _Consistency/ordering guarantees_
- _Performance budgets if relevant_

---

## 2. Core Concepts

_Technical concepts, technologies, and architectural patterns required to work in this subsystem. Agents should understand these before modifying any code here._

### [Concept Name]
_2-3 sentence explanation of what it is and why it matters to this subsystem._
- Key detail agents get wrong: _[common misconception or subtle gotcha]_
- Reference: _[link to external docs, internal doc, or canonical resource]_

### [Concept Name]
_..._
- Key detail agents get wrong: _[...]_
- Reference: _[...]_

---

## 3. File Tree

_Annotated map of every file in this subsystem. Update when adding/removing files._

```
src/[subsystem]/
├── index.ts                  # [What this file does]
├── [main-service].ts         # [What this file does]
├── types.ts                  # [What this file does]
├── errors.ts                 # [What this file does]
└── __tests__/
    └── [test files]
```

---

## 4. Data Models & Schemas

_Database tables, TypeScript types, and their relationships._

### Database Tables

```sql
[table_name]
├── id              UUID PRIMARY KEY
├── [field]         [TYPE] [CONSTRAINTS]  -- [notes]
├── created_at      TIMESTAMPTZ
└── updated_at      TIMESTAMPTZ
```

### Core TypeScript Types

```typescript
// [filename] — [what these represent]
interface [MainEntity] {
  id: string;
  // ...
}

type [EntityType] = 'option_a' | 'option_b';
```

### Key Indexes & Query Patterns
- _[Query shape]_ uses _[index]_ — target: _[latency budget]_

---

## 5. Conventions & Patterns

_Prescriptive rules for writing code in this subsystem. Agents MUST follow these._

### Do
- _[Pattern]_ — _why_
- _[Pattern]_ — _why_

### Don't
- _[Anti-pattern]_ — _what to do instead_
- _[Anti-pattern]_ — _what to do instead_

### Error Handling

```typescript
// Show the concrete pattern used in this subsystem
```

### Reliability
- Timeouts: _[values]_
- Retries/backoff: _[policy]_
- Idempotency: _[where/how, if applicable]_

### Testing Conventions
- _How to set up fixtures_
- _What to mock_
- _What must be covered_

---

## 6. Subsystem Deep Dives

_Detailed walkthrough of each major capability._

### 6.1 [Capability Name]

**What it does:** _1-2 sentences._

**Happy path:**
1. _Which file/function is called, what it does, what it calls next_
2. _..._

**Edge cases:**
- _[Scenario]_ → _[How it's handled]_

**Files touched:** _[list]_

### 6.2 [Capability Name]

_... repeat ..._

---

## 7. Cross-Cutting Concerns

_How this subsystem interacts with other subsystems and shared infrastructure._

| Dependency | Direction | Interface | Notes |
|---|---|---|---|
| [Other subsystem] | This → Other | `function()` | _When/why_ |
| [Other subsystem] | Other → This | `function()` | _When/why_ |

### Security & Auth
- _AuthN model for this subsystem_
- _AuthZ checks / permission model_
- _Sensitive data handling (redaction, encryption)_

### Observability
- _Required log fields_
- _Key metrics / alerts_

---

## 8. Acceptance Gates

_Checklist before any PR touching this subsystem is merged._

- [ ] Typecheck passes
- [ ] Relevant tests pass
- [ ] This spec is updated (file tree, data models, deep dives)

---

## 9. Known Limitations & Tech Debt

_Be aware of these but do NOT fix unless explicitly asked._

- [ ] _[Limitation]_ — _impact_ — _expected fix direction_
- [ ] _[Limitation]_ — _impact_ — _expected fix direction_