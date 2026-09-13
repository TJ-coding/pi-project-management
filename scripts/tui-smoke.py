#!/usr/bin/env python3
"""
Drive the real `pi` TUI in a pseudo-terminal, emulate the terminal with pyte and
assert on exact screen frames.

    pip install pyte
    python3 scripts/tui-smoke.py --ext ./src/index.ts --cwd /tmp/pm-demo

It checks that `/project` opens the dashboard, that the chrome is one line per
row, that views switch, that the footer reports the scroll state (and that the
content really moves when it is scrollable), and that `q` closes the view.

Generate a project with content first if you want full scroll coverage:

    node scripts/demo-project.ts /tmp/pm-demo
"""

import argparse
import codecs
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

try:
    import pyte
except ImportError:  # pragma: no cover - developer feedback
    print("This smoke test needs pyte:  pip install pyte", file=sys.stderr)
    sys.exit(2)


class PiSession:
    """A real pi process rendering into an emulated terminal."""

    def __init__(self, ext: str, cwd: str, cols: int = 100, rows: int = 30):
        self.cols, self.rows = cols, rows
        self.screen = pyte.Screen(cols, rows)
        self.screen.set_mode(pyte.modes.LNM)
        self.stream = pyte.Stream(self.screen)
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.pid, self.fd = pty.fork()
        if self.pid == 0:  # child
            # Size the pty before exec so pi starts with the right dimensions.
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            os.chdir(cwd)
            os.environ["TERM"] = "xterm-256color"
            os.execvp("pi", ["pi", "--no-session", "-e", ext])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        time.sleep(0.3)
        try:
            os.kill(self.pid, signal.SIGWINCH)
        except ProcessLookupError:
            pass

    def pump(self, seconds: float = 1.0) -> None:
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
            self.stream.feed(self.decoder.decode(chunk))

    def send(self, text: str) -> None:
        os.write(self.fd, text.encode())

    def lines(self) -> list[str]:
        return [line.rstrip() for line in self.screen.display]

    def text(self) -> str:
        return "\n".join(self.lines())

    def close(self) -> None:
        try:
            os.kill(self.pid, 9)
        except ProcessLookupError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass


def footer_range(frame: str) -> tuple[int, int, int] | None:
    """Parse the footer's `start-end/total lines` or `all N lines` readout."""
    match = re.search(r"(\d+)-(\d+)/(\d+) lines", frame)
    if match:
        return int(match.group(1)), int(match.group(2)), int(match.group(3))
    match = re.search(r"all (\d+) lines", frame)
    if match:
        total = int(match.group(1))
        return 1, total, total
    return None


def check(condition: bool, message: str, failures: list[str]) -> None:
    if not condition:
        failures.append(message)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ext", default="./src/index.ts")
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--cols", type=int, default=100)
    parser.add_argument("--rows", type=int, default=30)
    parser.add_argument("--dump", action="store_true", help="print the first dashboard frame and exit")
    args = parser.parse_args()

    failures: list[str] = []
    session_cwd = os.path.abspath(args.cwd)
    session = PiSession(os.path.abspath(args.ext), os.path.abspath(args.cwd), args.cols, args.rows)
    try:
        session.pump(7)
        session.send("/project")
        time.sleep(0.4)
        session.send("\r")
        session.pump(4)
        dashboard = session.text()

        if args.dump:
            print(dashboard)
            return 0

        check("Dashboard" in dashboard, "dashboard title missing", failures)

        # Chrome: exactly one rail line, one header line, one footer line.
        rail_lines = [line for line in session.lines() if "[1]" in line and "·" in line]
        check(len(rail_lines) == 1, f"view rail should occupy one line, found {len(rail_lines)}", failures)
        check(any("›" in line for line in session.lines()), "header breadcrumb missing", failures)
        stray_rules = [line for line in session.lines() if re.fullmatch(r"─+", line)]
        check(not stray_rules, f"stray separator lines (heading overflow): {stray_rules[:2]}", failures)

        # Footer must communicate the scroll state, and scrolling must work when
        # there is something to scroll.
        check(
            " all " in dashboard or "j/k" in dashboard or "lines" in dashboard,
            "footer does not describe the scroll state",
            failures,
        )
        before = footer_range(dashboard)
        check(before is not None, "footer does not show a line range", failures)
        if before and before[2] > (before[1] - before[0] + 1):
            start0 = before[0]
            session.send("j")
            session.pump(0.6)
            after_down = session.text()
            range_down = footer_range(after_down)
            check(range_down is not None and range_down[0] == start0 + 1, f"j did not scroll: {range_down}", failures)
            session.send("G")
            session.pump(0.6)
            range_end = footer_range(session.text())
            check(range_end is not None and range_end[1] == before[2], f"G did not jump to the end: {range_end}", failures)
            session.send("g")
            session.pump(0.6)
            range_home = footer_range(session.text())
            check(range_home is not None and range_home[0] == 1, f"g did not return to the top: {range_home}", failures)
        else:
            check(" all " in dashboard, "a view that fits should report 'all N lines' in the footer", failures)

        # In-place help on ?
        session.send("?")
        session.pump(1.0)
        help_frame = session.text()
        check("Project commands" in help_frame, "? did not open in-place help", failures)
        check("esc close help" in help_frame, "help footer missing", failures)
        check("/project edit <section>" in help_frame, "help does not mention direct editing", failures)
        session.send("?")
        session.pump(1.0)
        check("Project commands" not in session.text(), "? did not close in-place help", failures)

        # Graphical editing: e on Goals opens a picker, then a form.
        session.send("3")  # Goals
        session.pump(1.0)
        check("Goals" in session.text(), "digit 3 did not open Goals", failures)
        session.send("e")
        session.pump(1.5)
        picker = session.text()
        check("New goal" in picker, "e did not open the goal picker", failures)
        check("G1" in picker or "G2" in picker, "goal picker does not list existing goals", failures)

        session.send("\r")  # choose "＋ New goal"
        session.pump(1.5)
        form = session.text()
        check("Title" in form and "Priority" in form, "new goal form did not open", failures)
        check("↑↓" in form or "field" in form, "form help line missing", failures)

        session.send("\r")  # edit Title
        session.pump(0.6)
        session.send("Smoke goal")
        session.pump(0.6)
        session.send("\r")  # commit the field
        session.pump(0.6)
        session.send("s")  # save
        session.pump(2.0)
        saved_frame = session.text()
        check("Smoke goal" in saved_frame or "Goals" in saved_frame, "did not return to the dashboard after saving", failures)
        try:
            goals_file = os.path.join(session_cwd, ".project", "goals.yaml")
            check("Smoke goal" in open(goals_file, encoding="utf-8").read(), "saved goal missing from goals.yaml", failures)
        except OSError as error:
            failures.append(f"could not read goals.yaml: {error}")

        # Raw text editing: E on the same view opens the YAML, invalid text is rejected.
        session.send("E")
        session.pump(1.5)
        raw_frame = session.text()
        check("goals.yaml" in raw_frame or "id:" in raw_frame, "E did not open the raw text editor", failures)
        session.send("x")  # append garbage to the YAML
        session.pump(0.4)
        session.send("\r")  # submit
        session.pump(1.8)
        check("Edit rejected" in session.text(), "invalid raw edit was not rejected", failures)
        session.send("\x1b")  # dismiss the retry dialog
        session.pump(1.5)
        check("Goals" in session.text(), "did not return to the dashboard after rejecting an edit", failures)
        session.send("1")  # back to Dashboard for the navigation checks below
        session.pump(0.8)

        # Tab switches views, digit jumps to a specific view.
        session.send("\t")
        session.pump(1.2)
        switched = session.text()
        check("› Direction" in switched, "tab did not switch to Direction", failures)
        session.send("6")
        session.pump(1.2)
        risks = session.text()
        check("› Risks" in risks, "digit 6 did not open Risks", failures)
        check("▌" in risks, "structured section headers missing", failures)

        # DAG browser: grouped nodes, a selected-node detail pane, and a node form.
        session.send("8")
        session.pump(1.5)
        plan_view = session.text()
        check("▌ SELECTED" in plan_view, "plan view has no selected-node detail pane", failures)
        check("NEXT" in plan_view or "READY" in plan_view or "FINISHED" in plan_view, "plan groups missing", failures)
        check("READY" in plan_view or "RUNNING" in plan_view or "FINISHED" in plan_view, "plan groups missing", failures)
        session.send("\r")
        session.pump(1.8)
        node_form = session.text()
        check("Depends on" in node_form and "Type" in node_form, "plan node form did not open", failures)
        session.send("\x1b")  # cancel the node form
        session.pump(1.5)
        check("▌ SELECTED" in session.text(), "cancelling the node form did not return to the plan", failures)
        session.send("1")

        # Every rendered line must fit the terminal.
        for line in session.lines():
            check(len(line) <= args.cols, f"line wider than terminal: {line[:60]!r}", failures)

        # Close and confirm the dashboard is gone.
        session.send("q")
        session.pump(1.2)
        closed = session.text()
        check("› Dashboard" not in closed, "q did not close the dashboard", failures)
    finally:
        session.close()

    if failures:
        print("TUI SMOKE FAILURES:")
        for failure in failures:
            print(f"- {failure}")
        print("---- last dashboard frame ----")
        print(dashboard)
        return 1
    print("TUI SMOKE PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
