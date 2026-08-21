# Morrow: a gentle first walk with teammates

This is a slow, click-by-click tour for a brand-new Morrow install. The pictures use a disposable project named **Garden Notes**. Your buttons may be in a slightly different place, but the words should be similar.

![First launch](../../.verification-screenshots/blank-state-guide/01-first-launch.png)

## 1. Open Morrow and make one project

1. Start Morrow. On the welcome card, click **Explore first** (or **Begin**).
2. Click **Projects** on the left. You should see an empty Projects page: this is a good sign for a new install. [See the empty page](../../.verification-screenshots/blank-state-guide/02-projects-empty.png).
3. Click **New project**.
4. Type **Garden Notes**. Choose a local folder you are happy to let Morrow read. Click **Create project**.
5. The project now appears in the left side. [Project created](../../.verification-screenshots/blank-state-guide/03-project-created.png).

## 2. Hire two helpful teammates

1. In the project, click **New teammate**.
2. For the first teammate enter **Garden Research**. Job: **researcher**. Instructions: “Read project notes and explain what is known. Never change files.”
3. Choose a model shown in your **Model** list. If the list says **Project default** or “no provider,” leave it for now; see the test note below.
4. Open **Advanced memory**. Check **read Project**, **read Agent**, and **write Agent**. Click **Create teammate**. [Hiring and memory choices](../../.verification-screenshots/blank-state-guide/04-hiring-panel.png).
5. Repeat for **Garden Writer**. Job: **writer**. Instructions: “Turn research into a short, friendly note for the garden group.” Give it **read Project**, **read Personal**, and **write Project** memory access.
6. You may add a third teammate, such as **Garden Checker**, with **read Project** only. Keep the job small and clear. Teammates show **Idle** until they are working, then **Working**, then **Idle** again.

## 3. Give one teammate a direct job and inspect the evidence

1. Click **Garden Writer** in the teammate list. This opens a private, direct chat.
2. Type: “Please read the evidence file and tell me, in one sentence, what this workspace is ready for.” Click **Send**.
3. Watch the teammate change from **Working** to **Idle**. You should see **Completed · 1 tool**. [Direct chat](../../.verification-screenshots/blank-state-guide/05-direct-chat-evidence.png).
4. Click the completed activity, then click **Read evidence.txt**. The expanded card shows the file name, tool, time, and output. That card is evidence of what happened, not a guess. [Expanded evidence](../../.verification-screenshots/blank-state-guide/06-evidence-open.png).

## 4. Check identity and memory ownership

1. Beside a teammate, click **Configure**. Check its name, job, instructions, model, and memory scopes. Click **Inspect scoped memory** if it is available. [Identity and policy](../../.verification-screenshots/blank-state-guide/07-identity-memory-policy.png).
2. A new teammate may say **No durable records**. That is normal: a transcript is not memory. Agent memory belongs to that teammate; project memory is shared only where its policy allows it.
3. Click **Memory**, then **＋ Save memory**. Write “Use short, friendly notes for the garden group.” Set **Scope** to **Project**, then **Save memory**. The card should say **Owner: Shared in this project**, **Source: You wrote this**, and offer **Edit**, **Pin**, **Forget**, and **Delete permanently**. [Owned memory](../../.verification-screenshots/blank-state-guide/17-owned-memory.png).

## 5. Invite teammates into a group

1. Open a group conversation for this project. In this release, the visible UI has an **Invite** control once a group exists; if your build has no **New group** button, ask an administrator for the group link or use the advanced group-create step.
2. Click **Invite**, choose **Garden Writer**, and click **Invite**. The Participants strip should show a **Conductor** and a **participant**. [Group participants](../../.verification-screenshots/blank-state-guide/08-group-participants.png).
3. Remove or invite people from this same strip. A group message is shared with the listed participants; a direct chat is not.

## 6. Ask one teammate to ask another (approval first)

1. In the group, type: “Please ask Garden Writer to check whether evidence.txt says the workspace is ready.”
2. Morrow pauses. Read the card titled **One-shot teammate delegation**. It names Garden Writer and shows the bounded objective. Click **Allow once** to permit this request one time, or **Deny**. [Approval card](../../.verification-screenshots/blank-state-guide/09-ask-teammate-approval.png).
3. After allowing, the group records that Garden Writer replied. [Completed handoff](../../.verification-screenshots/blank-state-guide/10-ask-teammate-result.png).

This approval picture is a deterministic, local-only model-auth test. A real model may not decide to call `ask_teammate`; if no approval card appears, that is not proof that approvals are disabled.

## 7. Record, edit, and run a routine

1. Return to a direct teammate chat and click **Record a routine**. The panel says **Watching and learning**. Do a small task, then click **Stop recording**. [Recording panel](../../.verification-screenshots/blank-state-guide/11-routine-recording.png).
2. Read the draft. Give it a friendly **Name**, a clear **Purpose**, and check each observed step and target. Click **Save routine**.
3. Click **Skills**. Under **Routines**, click **Edit**. Change the name, purpose, or step, then **Save changes**. The editor reminds you that history and the original demonstration stay intact. [Routine editor](../../.verification-screenshots/blank-state-guide/12-routine-edit.png).
4. Click **Run**. Morrow opens a fresh teammate chat with the routine written as instructions. It re-checks permissions and the current workspace; it does not blindly replay old commands. [Fresh routine run](../../.verification-screenshots/blank-state-guide/16-routine-run.png).

## 8. Schedule, pause, resume, and inspect history

1. In **Skills → Scheduled routines**, find **Morning garden check**. Leave the example schedule `0 9 * * 1-5` (9:00 on weekdays), or type your own simple cron time.
2. Under **Notifications**, choose the events you care about: waiting for approval, completed, failed, and blocked. Choose **All configured adapters**, then click **Schedule**. You should see **Active**. [Active schedule and notifications](../../.verification-screenshots/blank-state-guide/13-schedule-active.png).
3. Click **Pause**. The label changes to **Paused**. [Paused schedule](../../.verification-screenshots/blank-state-guide/14-schedule-paused.png).
4. Click **Resume**; it changes back to **Active**. Click **Run now** for a safe test, then **History**. The ledger shows a completed or failed entry and its time. [Schedule history](../../.verification-screenshots/blank-state-guide/15-schedule-history.png).

## If something looks wrong

- **No project selected:** click the project name near the top, then repeat the step.
- **No model:** choose a configured model in the Model list, or ask the person who installed Morrow to configure a provider.
- **No durable records:** the teammate has not written owned memory yet; do not confuse this with missing chat history.
- **No messaging adapters configured:** notifications stay visible in Morrow, but there is nowhere external to deliver them. Add an adapter only when you want that.
- **No approval card:** check that the teammate has `ask_teammate` permission and try one short, bounded request. Cloud models are allowed to answer without using the tool.
- **Wrong person in a group:** open **Participants**, remove the person, and invite the correct teammate.
- **A page looks stale:** refresh once. If a task is still **Working**, wait for it to become **Idle** before retrying.

### What this tour proves

The captured run used an empty temporary Morrow home and workspace and never signed in or sent data outside `127.0.0.1`. The normal model selector could not show an external provider, so Garden Research and Garden Writer used a loopback `openai / demo-model` adapter only for the deterministic `ask_teammate` approval proof. In a normal install, use a provider and model that you have configured and trust. The test database and folder are disposable; do not delete or replace your everyday Morrow database while following this tour.
