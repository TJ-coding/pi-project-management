#!/usr/bin/env python3
"""
Drive the real `pi` TUI in a pseudo-terminal and check that `/project` opens the
dashboard and that the browser responds to keys.

    python3 scripts/tui-smoke.py --ext ./src/index.ts --cwd /tmp/demo
"""

import argparse
import codecs
import fcntl
import os
import pty
import re
import select
import struct
import sys
import termios
import time

ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]|\r")


def strip_ansi(text: str) -> str:
    return ANSI.sub("", text)


class PtyPi:
    def __init__(self, ext: str, cwd: str, cols: int = 120, rows: int = 40):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:  # child
            os.chdir(cwd)
            os.environ["TERM"] = "xterm-256color"
            os.environ["PI_HARDWARE_CURSOR"] = "0"
            os.execvp("pi", ["pi", "--no-session", "-e", ext])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.buffer = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def read(self, seconds: float = 1.0) -> str:
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([self.fd], [], [], 0.1)
            if not ready:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            self.buffer += self.decoder.decode(chunk)
        return self.buffer

    def send(self, text: str) -> None:
        os.write(self.fd, text.encode("utf-8"))

    def close(self) -> None:
        try:
            os.kill(self.pid, 9)
        except ProcessLookupError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ext", default="./src/index.ts")
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--timeout", type=float, default=25.0)
    parser.add_argument("--dump", action="store_true", help="print the stripped dashboard output and exit")
    args = parser.parse_args()

    pi = PtyPi(os.path.abspath(args.ext), os.path.abspath(args.cwd))
    failures: list[str] = []
    try:
        pi.read(6)
        pi.send("/project")
        time.sleep(0.4)
        pi.send("\r")
        dashboard = strip_ansi(pi.read(4))

        if args.dump:
            print(dashboard)
            return 0

        for marker in ["Dashboard", "Direction", "Goals", "State", "Intelligence", "Risks", "Strategy", "Plan / DAG"]:
            if marker not in dashboard:
                failures.append(f"tab bar marker missing from TUI: {marker}")
        if "Vision" not in dashboard and "VISION" not in dashboard:
            failures.append("dashboard did not render the vision section")
        if "switch" not in dashboard:
            failures.append("dashboard footer hints missing")

        # Tab switches views.
        pi.send("\t")
        time.sleep(0.3)
        switched = strip_ansi(pi.read(2))
        if "Direction" not in switched:
            failures.append("tab did not switch to another view")

        # Scroll and continue.
        pi.send("j")
        time.sleep(0.2)
        pi.send("j")
        time.sleep(0.3)
        pi.read(1)

        # Close the dashboard and open a section view via the command.
        pi.send("q")
        time.sleep(0.3)
        pi.read(1)
        pi.send("/project plan")
        time.sleep(0.3)
        pi.send("\r")
        plan_view = strip_ansi(pi.read(3))
        if "Plan / DAG" not in plan_view:
            failures.append("/project plan did not open the plan view")
        pi.send("q")
        time.sleep(0.3)
        pi.read(1)
    finally:
        pi.close()

    if failures:
        print("TUI SMOKE FAILURES:")
        for failure in failures:
            print(f"- {failure}")
        print("---- last output ----")
        print(strip_ansi(pi.buffer)[-4000:])
        return 1
    print("TUI SMOKE PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
