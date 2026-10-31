"""Run one Turn, a follow-up Turn, and resume the Session from its id."""

import asyncio
import sys

from minimax_code import MCode, ThreadOptions


async def main() -> None:
    client = MCode()
    thread = client.start_thread(ThreadOptions(cwd=".", permission="smart"))
    turn = await thread.run(sys.argv[1] if len(sys.argv) > 1 else "Say hello in one sentence.")
    print(turn.final_response)
    print("session:", thread.id, "usage:", turn.usage)

    assert thread.id is not None
    resumed = client.resume_thread(thread.id)
    print((await resumed.run("Repeat your previous answer in five words.")).final_response)


if __name__ == "__main__":
    asyncio.run(main())
