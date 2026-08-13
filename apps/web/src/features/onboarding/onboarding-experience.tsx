import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { assistantProfileApi, assistantProfileQueries } from "../../api/assistant-profile.js";
import { onboardingApi, onboardingKeys, onboardingQueries, type OnboardingUpdate } from "../../api/onboarding.js";
import { projectQueries } from "../../api/projects.js";
import { providerQueries } from "../../api/providers.js";

const SCENES = ["welcome", "privacy", "personalize", "readiness", "launch"] as const;
type Scene = (typeof SCENES)[number];
type PrivacyMode = "local_only" | "controlled_cloud";
type UseCase = "building" | "research" | "everyday";

const SCENE_TITLES: Record<Scene, string> = {
  welcome: "Welcome to Morrow",
  privacy: "Privacy",
  personalize: "Personalize Morrow",
  readiness: "Connect the essentials",
  launch: "Morrow is ready",
};

const USE_CASES: Array<{ id: UseCase; label: string }> = [
  { id: "building", label: "Building products" },
  { id: "research", label: "Research & thinking" },
  { id: "everyday", label: "Everyday work" },
];

const SCULPTURE_URL = `${import.meta.env.BASE_URL}assets/onboarding/morrow-continuity.webp`;

function normalizeScene(value: string | null | undefined): Scene {
  return SCENES.includes(value as Scene) ? (value as Scene) : "welcome";
}

function Progress({ scene }: { scene: Scene }) {
  const active = SCENES.indexOf(scene);
  return (
    <div aria-label={`Step ${active + 1} of ${SCENES.length}`} className="morrow-onboarding__progress" role="progressbar" aria-valuemax={SCENES.length} aria-valuemin={1} aria-valuenow={active + 1}>
      {SCENES.map((item, index) => <span data-active={index <= active ? "true" : undefined} key={item} />)}
    </div>
  );
}

function StageActions({ back, children }: { back?: () => void; children: ReactNode }) {
  return (
    <div className="morrow-onboarding__actions">
      {children}
      {back ? <button className="morrow-onboarding__text-action" onClick={back} type="button">Back</button> : null}
    </div>
  );
}

function WelcomeScene({ begin, explore, pending }: { begin: () => void; explore: () => void; pending: boolean }) {
  return (
    <div className="morrow-onboarding__welcome">
      <div className="morrow-onboarding__copy">
        <h1 id="morrow-onboarding-heading">Your private intelligence, ready to grow with you.</h1>
        <p>Morrow works across your projects, remembers what matters, and keeps every decision visible.</p>
        <StageActions>
          <button autoFocus className="morrow-onboarding__primary" disabled={pending} onClick={begin} type="button">Begin</button>
          <button className="morrow-onboarding__text-action" disabled={pending} onClick={explore} type="button">Explore first</button>
        </StageActions>
      </div>
    </div>
  );
}

function PrivacyScene({ back, continueToNext, mode, pending, setMode }: {
  back: () => void;
  continueToNext: () => void;
  mode: PrivacyMode;
  pending: boolean;
  setMode: (mode: PrivacyMode) => void;
}) {
  return (
    <div className="morrow-onboarding__split">
      <div className="morrow-onboarding__copy">
        <h1 id="morrow-onboarding-heading">Privacy, with you in control.</h1>
        <p>Your workspace and settings stay local. Configured cloud models receive context only when you choose to use them.</p>
      </div>
      <div className="morrow-onboarding__controls">
        <div className="morrow-onboarding__promises">
          <p><ShieldCheck aria-hidden="true" size={18} /><span><strong>Local control</strong>Your projects and settings stay on this machine.</span></p>
          <p><ShieldCheck aria-hidden="true" size={18} /><span><strong>Provider choice</strong>You choose the model provider for your work.</span></p>
          <p><ShieldCheck aria-hidden="true" size={18} /><span><strong>Memory you own</strong>Review, edit, disable, or remove anything Morrow learns.</span></p>
        </div>
        <fieldset className="morrow-onboarding__choices">
          <legend>Privacy preference</legend>
          <label data-selected={mode === "local_only" ? "true" : undefined}>
            <input checked={mode === "local_only"} name="privacy" onChange={() => setMode("local_only")} type="radio" />
            <span><strong>Local-first preference</strong><small>Records your preference; it does not block configured cloud providers.</small></span>
          </label>
          <label data-selected={mode === "controlled_cloud" ? "true" : undefined}>
            <input checked={mode === "controlled_cloud"} name="privacy" onChange={() => setMode("controlled_cloud")} type="radio" />
            <span><strong>Cloud available</strong><small>Records that configured cloud providers are acceptable for your work.</small></span>
          </label>
        </fieldset>
        <StageActions back={back}><button className="morrow-onboarding__primary" disabled={pending} onClick={continueToNext} type="button">Continue</button></StageActions>
      </div>
    </div>
  );
}

function PersonalizeScene({ back, continueToNext, name, pending, setName, setUseCase, useCase }: {
  back: () => void;
  continueToNext: () => void;
  name: string;
  pending: boolean;
  setName: (name: string) => void;
  setUseCase: (useCase: UseCase) => void;
  useCase: UseCase;
}) {
  return (
    <div className="morrow-onboarding__split">
      <div className="morrow-onboarding__copy">
        <h1 id="morrow-onboarding-heading">Make it yours.</h1>
        <p>A few details help Morrow feel personal from the first conversation.</p>
      </div>
      <div className="morrow-onboarding__controls">
        <label className="morrow-onboarding__name">
          <span>What should Morrow call you?</span>
          <input autoComplete="name" maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="Your name" type="text" value={name} />
        </label>
        <fieldset className="morrow-onboarding__choices">
          <legend>What will you use Morrow for most?</legend>
          {USE_CASES.map((item) => (
            <label data-selected={useCase === item.id ? "true" : undefined} key={item.id}>
              <input checked={useCase === item.id} name="use-case" onChange={() => setUseCase(item.id)} type="radio" />
              <span><strong>{item.label}</strong></span>
            </label>
          ))}
        </fieldset>
        <p className="morrow-onboarding__aside">You can change any of this later.</p>
        <StageActions back={back}><button className="morrow-onboarding__primary" disabled={pending} onClick={continueToNext} type="button">Continue</button></StageActions>
      </div>
    </div>
  );
}

function ReadinessScene({ back, continueToNext, modelReady, pending, projectReady, refresh, refreshing }: {
  back: () => void;
  continueToNext: () => void;
  modelReady: boolean;
  pending: boolean;
  projectReady: boolean;
  refresh: () => void;
  refreshing: boolean;
}) {
  const ready = modelReady && projectReady;
  return (
    <div className="morrow-onboarding__split">
      <div className="morrow-onboarding__copy">
        <h1 id="morrow-onboarding-heading">Connect the essentials.</h1>
        <p>A model gives Morrow intelligence. A project gives it a safe, bounded place to work.</p>
      </div>
      <div className="morrow-onboarding__controls">
        <div className="morrow-onboarding__readiness">
          <div data-ready={modelReady ? "true" : undefined}>
            <span aria-hidden="true">{modelReady ? <Check size={17} /> : "01"}</span>
            <p><strong>{modelReady ? "Model connected" : "Connect a model"}</strong><small>{modelReady ? "Morrow has a configured provider." : "Choose from local or cloud providers."}</small></p>
            {!modelReady ? <Link to="/connections">Connect a model</Link> : null}
          </div>
          <div data-ready={projectReady ? "true" : undefined}>
            <span aria-hidden="true">{projectReady ? <Check size={17} /> : "02"}</span>
            <p><strong>{projectReady ? "Project ready" : "Add a project"}</strong><small>{projectReady ? "Morrow has a bounded workspace." : "Select a folder already on this machine."}</small></p>
            {!projectReady ? <Link to="/projects">Add a project</Link> : null}
          </div>
        </div>
        <button className="morrow-onboarding__refresh" disabled={refreshing} onClick={refresh} type="button">{refreshing ? "Checking…" : "Check again"}</button>
        <StageActions back={back}>
          <button className="morrow-onboarding__primary" disabled={pending} onClick={continueToNext} type="button">{ready ? "Continue" : "Continue with setup later"}</button>
        </StageActions>
      </div>
    </div>
  );
}

function LaunchScene({ back, open, pending }: { back: () => void; open: () => void; pending: boolean }) {
  return (
    <div className="morrow-onboarding__launch">
      <span aria-hidden="true" className="morrow-onboarding__launch-mark"><Check size={26} strokeWidth={1.7} /></span>
      <h1 id="morrow-onboarding-heading">Morrow is yours.</h1>
      <p>Start a conversation, open a project, or simply explore. Morrow will learn carefully as you work.</p>
      <StageActions back={back}><button autoFocus className="morrow-onboarding__primary" disabled={pending} onClick={open} type="button">Open Morrow</button></StageActions>
    </div>
  );
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hasAttribute("hidden"));
}

export function OnboardingExperience({ pathname }: { pathname: string }) {
  const queryClient = useQueryClient();
  const onboarding = useQuery(onboardingQueries.state(pathname === "/"));
  const [sceneOverride, setSceneOverride] = useState<Scene | null>(null);
  const scene = sceneOverride ?? normalizeScene(onboarding.data?.onboardingStep);
  const [privacy, setPrivacy] = useState<PrivacyMode>("local_only");
  const [name, setName] = useState("");
  const [useCase, setUseCase] = useState<UseCase>("building");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const providers = useQuery({ ...providerQueries.list(), enabled: pathname === "/" && scene === "readiness" });
  const projects = useQuery({ ...projectQueries.list(), enabled: pathname === "/" && scene === "readiness" });
  const modelReady = (providers.data ?? []).some((provider) => provider.configured && provider.id !== "mock");
  const projectReady = (projects.data?.length ?? 0) > 0;
  const active = pathname === "/" && onboarding.isSuccess && !onboarding.data.onboarded;

  useEffect(() => {
    if (!onboarding.data) return;
    setName(onboarding.data.name ?? "");
    if (USE_CASES.some((item) => item.id === onboarding.data?.useCase)) setUseCase(onboarding.data.useCase as UseCase);
  }, [onboarding.data]);

  useEffect(() => {
    if (!active) return;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => focusableElements(dialogRef.current ?? document.body)[0]?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = priorOverflow;
    };
  }, [active, scene]);

  if (pathname !== "/" || onboarding.isError) return null;
  if (onboarding.isPending) return <div aria-hidden="true" className="morrow-onboarding-loading" />;
  if (!active) return null;

  async function update(input: OnboardingUpdate, next?: Scene) {
    setPending(true);
    setError(null);
    try {
      await onboardingApi.update(input);
      queryClient.setQueryData(onboardingKeys.state, { ...onboarding.data, ...input });
      if (next) setSceneOverride(next);
    } catch {
      setError("Morrow couldn't save that yet. Try again.");
    } finally {
      setPending(false);
    }
  }

  async function savePrivacy() {
    setPending(true);
    setError(null);
    try {
      const updatedProfile = await assistantProfileApi.update({ defaultPrivacyMode: privacy });
      queryClient.setQueryData(assistantProfileQueries.get().queryKey, updatedProfile);
      await onboardingApi.update({ onboardingStep: "personalize" });
      queryClient.setQueryData(onboardingKeys.state, { ...onboarding.data, onboardingStep: "personalize" });
      setSceneOverride("personalize");
    } catch {
      setError("Morrow couldn't save that yet. Try again.");
    } finally {
      setPending(false);
    }
  }

  async function savePersonalization() {
    setPending(true);
    setError(null);
    try {
      const trimmedName = name.trim();
      if (trimmedName) {
        const updatedProfile = await assistantProfileApi.update({ displayName: trimmedName });
        queryClient.setQueryData(assistantProfileQueries.get().queryKey, updatedProfile);
      }
      const input = { name: trimmedName || null, onboardingStep: "readiness", useCase } as const;
      await onboardingApi.update(input);
      queryClient.setQueryData(onboardingKeys.state, { ...onboarding.data, ...input });
      setSceneOverride("readiness");
    } catch {
      setError("Morrow couldn't save that yet. Try again.");
    } finally {
      setPending(false);
    }
  }

  function goBack(target: Scene) {
    void update({ onboardingStep: target }, target);
  }

  function handleDialogKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div aria-label={SCENE_TITLES[scene]} aria-modal="true" className="morrow-onboarding" data-scene={scene} onKeyDown={handleDialogKeys} ref={dialogRef} role="dialog">
      <header className="morrow-onboarding__header"><strong>Morrow</strong><span>{SCENES.indexOf(scene) + 1} of 5</span></header>
      <img alt="" aria-hidden="true" className="morrow-onboarding__sculpture" src={SCULPTURE_URL} />
      <main className="morrow-onboarding__stage" key={scene}>
        {scene === "welcome" ? <WelcomeScene begin={() => void update({ onboardingStep: "privacy" }, "privacy")} explore={() => void update({ onboarded: true, onboardingStep: null })} pending={pending} /> : null}
        {scene === "privacy" ? <PrivacyScene back={() => goBack("welcome")} continueToNext={() => void savePrivacy()} mode={privacy} pending={pending} setMode={setPrivacy} /> : null}
        {scene === "personalize" ? <PersonalizeScene back={() => goBack("privacy")} continueToNext={() => void savePersonalization()} name={name} pending={pending} setName={setName} setUseCase={setUseCase} useCase={useCase} /> : null}
        {scene === "readiness" ? <ReadinessScene back={() => goBack("personalize")} continueToNext={() => void update({ onboardingStep: "launch" }, "launch")} modelReady={modelReady} pending={pending} projectReady={projectReady} refresh={() => void Promise.all([providers.refetch(), projects.refetch()])} refreshing={providers.isFetching || projects.isFetching} /> : null}
        {scene === "launch" ? <LaunchScene back={() => goBack("readiness")} open={() => void update({ onboarded: true, onboardingStep: null })} pending={pending} /> : null}
        {error ? <p className="morrow-onboarding__error" role="alert">{error}</p> : null}
      </main>
      <footer className="morrow-onboarding__footer"><span>Local-first. Provider-neutral. Yours.</span><Progress scene={scene} /></footer>
    </div>
  );
}
