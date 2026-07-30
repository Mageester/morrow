import { describe, expect, it } from "vitest";
import {
  extractObjectiveRequirements,
  isServiceCommand,
  mergeCriteria,
  objectiveRequirementCriteria,
  propagateServiceCommand,
} from "../src/mission/objective-requirements.js";
import type { DraftCriterion } from "../src/mission/criteria.js";

/**
 * Requirement preservation.
 *
 * Reproduced live against the packaged build: this exact objective produced
 * exactly two success criteria — "The final diff contains no unrelated changes
 * outside the intended fix" and "An independent reviewer approves the change
 * against the objective". Seven explicit requirements vanished, so the mission
 * could be graded complete without tests passing, without persistence, without
 * the server starting, and without a README.
 */
const OBJECTIVE = [
  "Build a working Taskflow task-tracking web app here.",
  "Backend: a Node.js standard-library HTTP server with GET /api/tasks, POST /api/tasks, PATCH /api/tasks/:id to toggle done, DELETE /api/tasks/:id.",
  "Persistence: tasks are stored on disk in a JSON file and survive a server restart.",
  "Frontend: a browser UI served by the same server that lists tasks and can add, complete and delete them without a full page reload.",
  "Responsive: the UI must be usable at a 1280x800 desktop viewport and at a 375x812 mobile viewport.",
  "Tests: an automated test suite covering every API route, runnable with npm test, that passes.",
  "Documentation: a README.md covering install, run, test and the API routes.",
  "The app must start with npm start and serve both the UI and the API on a local port.",
  "Use only the Node.js standard library plus a test runner; do not require a database server.",
].join(" ");

describe("stated requirements survive criteria generation", () => {
  const requirements = extractObjectiveRequirements(OBJECTIVE);

  it("keeps every labelled requirement the user wrote", () => {
    const categories = requirements.map((requirement) => requirement.category);
    for (const expected of ["api", "persistence", "frontend", "responsive", "test", "documentation", "runtime"]) {
      expect(categories, `missing a ${expected} requirement`).toContain(expected);
    }
  });

  it("produces one independently checkable criterion per requirement, not a summary", () => {
    expect(requirements.length).toBeGreaterThanOrEqual(7);
    expect(new Set(requirements.map((requirement) => requirement.statement)).size).toBe(requirements.length);
  });

  it("keeps the user's own wording so a requirement stays recognisable", () => {
    const persistence = requirements.find((requirement) => requirement.category === "persistence");
    expect(persistence?.statement).toContain("survive a server restart");
    const documentation = requirements.find((requirement) => requirement.category === "documentation");
    expect(documentation?.statement).toContain("README.md");
  });

  it("uses a command the user named as runnable evidence", () => {
    const tests = requirements.find((requirement) => requirement.category === "test");
    expect(tests?.verification).toMatchObject({ kind: "test", command: "npm test", expectExitCode: 0 });
    const runtime = requirements.find((requirement) => requirement.statement.includes("npm start"));
    expect(runtime?.verification.command).toBe("npm start");
  });

  it("never invents a command the user did not name", () => {
    const responsive = requirements.find((requirement) => requirement.category === "responsive");
    expect(responsive?.verification.command).toBeUndefined();
    // Still authoritative and still needs evidence — a browser check, not silence.
    expect(responsive?.verification.kind).toBe("browser");
  });

  it("records prohibitions as requirements too", () => {
    const constraint = requirements.find((requirement) => /do not require a database/i.test(requirement.statement));
    expect(constraint).toBeDefined();
  });
});

describe("merging with generated criteria", () => {
  const generated: DraftCriterion[] = [
    { description: "The final diff contains no unrelated changes outside the intended fix", verification: { kind: "diff", pathScope: "**" } },
    { description: "An independent reviewer approves the change against the objective", verification: { kind: "review" } },
  ];

  it("puts stated requirements first and keeps the generic ones after", () => {
    const merged = mergeCriteria(objectiveRequirementCriteria(OBJECTIVE), generated);
    expect(merged.length).toBeGreaterThan(generated.length);
    expect(merged.at(-1)!.description).toContain("independent reviewer");
    expect(merged[0]!.description).not.toContain("unrelated changes");
  });

  it("never drops a stated requirement in favour of a generated one", () => {
    const stated = objectiveRequirementCriteria(OBJECTIVE);
    const merged = mergeCriteria(stated, generated);
    for (const requirement of stated) {
      expect(merged.map((draft) => draft.description)).toContain(requirement.description);
    }
  });

  it("does not duplicate a generated criterion that restates a requirement", () => {
    const stated: DraftCriterion[] = [{ description: "Tests: npm test passes", verification: { kind: "test", command: "npm test" } }];
    const merged = mergeCriteria(stated, [{ description: "tests:  NPM TEST passes.", verification: { kind: "test" } }]);
    expect(merged).toHaveLength(1);
  });
});

describe("conservative extraction", () => {
  it("lifts nothing from an objective that states no requirements", () => {
    expect(extractObjectiveRequirements("Have a look at this repository and tell me what it does.")).toEqual([]);
  });

  it("does not treat ordinary prose framing as a requirement", () => {
    const requirements = extractObjectiveRequirements("Build a small CLI. It reads a file and prints a summary.");
    expect(requirements).toEqual([]);
  });

  it("ignores obligations on the run rather than on the deliverable", () => {
    // "the mission must survive a service restart" is an instruction about how
    // the work is carried out. Lifting it yields a criterion with nothing to
    // verify, which then blocks completion forever.
    expect(extractObjectiveRequirements("Repair a syntax error; the mission must survive a service restart.")).toEqual([]);
    expect(extractObjectiveRequirements("You must not stop until it works.")).toEqual([]);
  });

  it("still lifts obligations on the deliverable itself", () => {
    const requirements = extractObjectiveRequirements("The app must start with npm start and serve the UI.");
    expect(requirements).toHaveLength(1);
    expect(requirements[0]!.verification.command).toBe("npm start");
  });

  it("is bounded so a very long objective cannot produce unbounded criteria", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Requirement${i}: the system must satisfy condition number ${i} exactly.`).join(" ");
    expect(extractObjectiveRequirements(long).length).toBeLessThanOrEqual(12);
  });

  it("does not split a viewport size or an API path into separate requirements", () => {
    const requirements = extractObjectiveRequirements("Responsive: the UI must work at 1280x800 and 375x812. Backend: PATCH /api/tasks/:id must toggle done.");
    expect(requirements).toHaveLength(2);
    expect(requirements[0]!.statement).toContain("375x812");
    expect(requirements[1]!.statement).toContain("/api/tasks/:id");
  });
});

/**
 * A startup command is not an exiting command.
 *
 * `npm start` was emitted as `{ kind: "command", expectExitCode: 0 }`. A
 * working server never exits, so that check could only ever run out its
 * timeout — the requirement the user cared most about was unprovable by
 * construction, and killing the server on timeout is what made every
 * subsequent API and browser check fail with ECONNREFUSED.
 */
describe("service commands are proven by starting them, not by waiting for an exit", () => {
  it.each(["npm start", "npm run dev", "pnpm start", "yarn serve", "npm run preview"])("treats %s as a service", (command) => {
    expect(isServiceCommand(command)).toBe(true);
  });

  it.each(["npm test", "npm run build", "npm ci", "npm install", "node --test"])("treats %s as an exiting command", (command) => {
    expect(isServiceCommand(command)).toBe(false);
  });

  it("emits a service strategy for a stated startup command", () => {
    const requirements = extractObjectiveRequirements("The app must start with npm start and serve both the UI and the API on a local port.");
    expect(requirements[0]!.verification).toMatchObject({ kind: "runtime", command: "npm start", service: true });
    // Never an exit-code check: a healthy server does not exit.
    expect(requirements[0]!.verification.expectExitCode).toBeUndefined();
  });

  it("still checks an exiting command by its exit code", () => {
    const requirements = extractObjectiveRequirements("Tests: an automated test suite runnable with npm test, that passes.");
    expect(requirements[0]!.verification).toMatchObject({ kind: "test", command: "npm test", expectExitCode: 0 });
    expect(requirements[0]!.verification.service).toBeUndefined();
  });

  it("emits a browser service strategy when the UI requirement names the startup command", () => {
    const requirements = extractObjectiveRequirements("Frontend: the browser UI must be served by npm start and list tasks.");
    expect(requirements[0]!.verification).toMatchObject({ kind: "browser", command: "npm start", service: true });
  });
});

describe("propagateServiceCommand", () => {
  const service: DraftCriterion = {
    description: "The app must start with npm start and serve both the UI and the API on a local port.",
    verification: { kind: "runtime", command: "npm start", service: true },
  };

  it("gives service-dependent criteria the service the objective already named", () => {
    const browser: DraftCriterion = { description: "Responsive at 1280x800 and 375x812", verification: { kind: "browser" } };
    const api: DraftCriterion = { description: "GET /api/tasks returns the list", verification: { kind: "runtime" } };
    const [, propagatedBrowser, propagatedApi] = propagateServiceCommand([service, browser, api]);
    expect(propagatedBrowser!.verification).toMatchObject({ kind: "browser", command: "npm start", service: true });
    expect(propagatedApi!.verification).toMatchObject({ kind: "runtime", command: "npm start", service: true });
  });

  it("never invents a service the objective did not name", () => {
    const browser: DraftCriterion = { description: "Responsive at 1280x812", verification: { kind: "browser" } };
    expect(propagateServiceCommand([browser])).toEqual([browser]);
  });

  it("leaves criteria that already have their own command alone", () => {
    const tests: DraftCriterion = { description: "npm test passes", verification: { kind: "test", command: "npm test", expectExitCode: 0 } };
    const [, propagated] = propagateServiceCommand([service, tests]);
    expect(propagated!.verification).toEqual(tests.verification);
  });

  it("does not touch diff, review or manual criteria", () => {
    const review: DraftCriterion = { description: "A reviewer approves", verification: { kind: "review" } };
    const manual: DraftCriterion = { description: "README covers the routes", verification: { kind: "manual" } };
    const [, propagatedReview, propagatedManual] = propagateServiceCommand([service, review, manual]);
    expect(propagatedReview!.verification).toEqual(review.verification);
    expect(propagatedManual!.verification).toEqual(manual.verification);
  });
});
