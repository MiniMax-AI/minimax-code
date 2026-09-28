# Pocket Pet: teach a blinking face to help you focus

A small browser project for a real coding-agent workflow: add a timer, then change the interaction. No hardware, framework, package installation, or external assets are needed to run the example.

## Requirements

- Node.js 22.19+ and a modern browser. The local server binds only to `127.0.0.1:4173`.
- To have the agent edit the starter: install [MCode](../../README.md#quick-start) and configure a MiniMax account with available credits or your own compatible model API. Model calls may incur charges. Source availability does not make hosted inference free.
- Running the finished example and its tests needs no account or model call.

## Try the finished pet

From the repository root:

```bash
node examples/pocket-pet/serve.mjs finished
```

Open `http://127.0.0.1:4173`. The mode links switch between a normal session and the 10-second demo; switching modes resets the timer. Click **Start** for a 25-minute focus session. While running, hold the button for 0.8 seconds to pause; **Resume** is an ordinary click. Space and Enter work with the focused button. Completion triggers a short celebration; **Reset** prepares another session.

For a quick demonstration, open `http://127.0.0.1:4173/?demo=1`. The screen explicitly labels its **10-second demo mode**. It is not a sped-up 25-minute session. Stop the server with Ctrl+C before starting another copy.

## Build it yourself

Create an independent copy so the agent does not edit the repository:

```bash
node examples/pocket-pet/setup.mjs ../my-pocket-pet
cd ../my-pocket-pet
node serve.mjs
```

The setup command refuses an existing destination. Open the URL above. In a second terminal, change to the same `my-pocket-pet` directory and run `mcode`. Use the normal permission prompts to review file edits and test execution.

### First request

Paste [prompt-1.txt](prompt-1.txt):

> Give this browser pocket pet a working Pomodoro timer. Keep its existing visual design. Start with 25 minutes, show MM:SS, let the button start, pause, and resume, and give it a focused expression while running. Add a clearly labeled 10-second demo mode through ?demo=1 so the video does not imply 25 minutes passed in real time. Use an elapsed-time deadline so background tabs do not slow the clock. Extract pure timer logic into timer.mjs and write node:test tests for start, pause, resume, completion, and reset. Use no external dependencies, network requests, or assets. Keep all work in this directory. Update the intro to say "A little focus. A little company." and explain the working controls. Run the tests. Do not commit. Reply briefly in English with the actual result.

Refresh the browser. Check Start → Pause → Resume, and let demo mode finish. Read the actual test output.

### Change the requirement

In the same session, paste [prompt-2.txt](prompt-2.txt):

> Change the requirement: while the timer is running, pause only after holding the button for 800 ms. A short click must not pause it. Support pointer and keyboard (Space or Enter), cancel a pending hold on pointer cancellation, lost capture, or window blur, and keep start/resume as normal clicks. Show a visible hold progress indicator and explain the control. When the timer completes, make the pet celebrate with a short finite animation, respecting prefers-reduced-motion. Keep the labeled ?demo=1 mode. Add regression tests for the hold threshold and cancellation; run all tests. Keep the existing design, use no dependencies, and do not commit. Reply briefly in English with actual results.

Refresh again. Confirm a short tap leaves the timer running; a hold pauses it; a normal click resumes it; completion celebrates. Model output varies: inspect its changes and verify the behavior rather than expecting byte-identical files.

## Verify the reference implementation

```bash
node --test examples/pocket-pet/finished/timer.test.mjs examples/pocket-pet/finished/hold.test.mjs
```

The shipped `finished/` reference is based on a real MiniMax Code 0.5.8 BYOK session, followed by maintainer visual polish and browser verification. The shipped reference has a revised design, a session progress bar, short-tap feedback, and visible mode links; these are documented maintainer additions beyond the two prompts. The starter was designed beforehand. This demonstrates the agent modifying an existing project; it is not a claim that the CLI generated the entire design from an empty directory. See [recording details](../../docs/demo.md).

The example keeps state in memory. Reloading resets the timer. It is an educational example, not an alarm service guaranteed to run while a computer sleeps.
