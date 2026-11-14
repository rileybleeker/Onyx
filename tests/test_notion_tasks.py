"""Offline tests for the Notes payload builder in tools/notion_tasks.py.

No network, no token, no install (httpx is only imported when a request is made).
Synthetic text only.

    python tests/test_notion_tasks.py
"""
import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import notion_tasks as nt  # noqa: E402

EMOJI = "\U0001F600"  # one code point, two UTF-16 code units, four UTF-8 bytes
BOLD = {"bold": True, "italic": False, "strikethrough": False, "underline": False, "code": False,
        "color": "red"}
PLAIN = {"bold": False, "italic": False, "strikethrough": False, "underline": False, "code": False,
         "color": "default"}


def read_obj(content, annotations=PLAIN, url=None):
    """A text object shaped like the API returns it (with the read-only keys)."""
    return {"type": "text", "text": {"content": content, "link": {"url": url} if url else None},
            "annotations": dict(annotations), "plain_text": content, "href": url}


def contents(objs):
    return [o["text"]["content"] for o in objs]


def joined(objs):
    return "".join(contents(objs))


def utf16_units(s):
    return len(s.encode("utf-16-le")) // 2


def has_lone_surrogate(s):
    try:
        s.encode("utf-16-le").decode("utf-16-le")
        s.encode("utf-8")
    except UnicodeError:
        return True
    return False


class SplitText(unittest.TestCase):
    def test_short_text_is_one_piece(self):
        self.assertEqual(nt.split_text("hello"), ["hello"])
        self.assertEqual(nt.split_text("a" * 2000), ["a" * 2000])
        self.assertEqual(nt.split_text(""), [""])

    def test_long_text_round_trips_in_pieces_of_at_most_2000(self):
        s = "".join(chr(ord("a") + i % 26) for i in range(5321)) + "\nline two\ttab"
        pieces = nt.split_text(s)
        self.assertEqual("".join(pieces), s)
        self.assertEqual([len(p) for p in pieces], [2000, 2000, 1334])

    def test_limit_counts_utf16_units_not_code_points(self):
        # 1,001 emoji are 1,001 code points but 2,002 UTF-16 units: Notion refuses that.
        s = EMOJI * 1001
        pieces = nt.split_text(s)
        self.assertEqual(pieces, [EMOJI * 1000, EMOJI])
        self.assertTrue(all(utf16_units(p) <= 2000 for p in pieces))

    def test_never_cuts_inside_a_surrogate_pair(self):
        # The emoji straddles units 2000-2001: it must move whole to the next piece.
        s = "a" * 1999 + EMOJI + "b" * 10
        pieces = nt.split_text(s)
        self.assertEqual(pieces, ["a" * 1999, EMOJI + "b" * 10])
        for offset in range(0, 5):  # every alignment of a run of pairs against the boundary
            s = "x" * offset + (EMOJI + "é€") * 1500
            pieces = nt.split_text(s)
            self.assertEqual("".join(pieces), s)
            self.assertEqual("".join(pieces).encode("utf-8"), s.encode("utf-8"))
            for p in pieces:
                self.assertLessEqual(utf16_units(p), 2000)
                self.assertFalse(has_lone_surrogate(p))
                self.assertTrue(p)

    def test_bmp_multibyte_counts_one_unit_each(self):
        s = "€" * 2000  # 6,000 UTF-8 bytes, 2,000 UTF-16 units: fits in one object
        self.assertEqual(nt.split_text(s), [s])

    def test_utf16_len(self):
        self.assertEqual(nt.utf16_len("abc"), 3)
        self.assertEqual(nt.utf16_len("€" + EMOJI), 3)

    def test_tiny_limit_is_rejected(self):
        with self.assertRaises(ValueError):
            nt.split_text("abc", limit=1)


class WritableRichText(unittest.TestCase):
    def test_short_objects_are_untouched(self):
        rich = [read_obj("first "), read_obj("linked", BOLD, "https://example.com/a"), read_obj(" last")]
        out = nt.writable_rich_text(rich)
        self.assertEqual(len(out), 3)
        self.assertEqual(contents(out), ["first ", "linked", " last"])
        self.assertEqual(out[1]["text"]["link"], {"url": "https://example.com/a"})
        self.assertEqual(out[1]["annotations"], BOLD)
        self.assertIsNone(out[0]["text"]["link"])
        for o in out:  # read-only keys are not sent back
            self.assertEqual(sorted(o), ["annotations", "text", "type"])

    def test_long_object_splits_and_keeps_link_and_annotations_on_every_piece(self):
        body = "".join(str(i % 10) for i in range(4500))
        rich = [read_obj("intro "), read_obj(body, BOLD, "https://example.com/long"), read_obj(" outro")]
        out = nt.writable_rich_text(rich)
        self.assertEqual(joined(out), "intro " + body + " outro")
        self.assertEqual([len(c) for c in contents(out)], [6, 2000, 2000, 500, 6])
        for piece in out[1:4]:
            self.assertEqual(piece["annotations"], BOLD)
            self.assertEqual(piece["text"]["link"], {"url": "https://example.com/long"})
        self.assertEqual(out[0]["annotations"], PLAIN)
        self.assertIsNone(out[4]["text"]["link"])
        # pieces do not share one dict: changing one must not change its neighbours
        out[1]["annotations"]["bold"] = False
        out[1]["text"]["link"]["url"] = "changed"
        self.assertTrue(out[2]["annotations"]["bold"])
        self.assertEqual(out[2]["text"]["link"]["url"], "https://example.com/long")

    def test_input_is_not_modified(self):
        rich = [read_obj("z" * 4100, BOLD, "https://example.com/x")]
        snapshot = copy.deepcopy(rich)
        nt.writable_rich_text(rich)
        self.assertEqual(rich, snapshot)

    def test_mentions_and_equations_pass_through(self):
        mention = {"type": "mention", "mention": {"type": "page", "page": {"id": "0" * 32}},
                   "annotations": dict(PLAIN), "plain_text": "A page", "href": None}
        equation = {"type": "equation", "equation": {"expression": "e=mc^2"},
                    "annotations": dict(PLAIN), "plain_text": "e=mc^2", "href": None}
        out = nt.writable_rich_text([read_obj("a"), mention, equation])
        self.assertEqual(out[1], mention)
        self.assertEqual(out[2], equation)


class BuildAppend(unittest.TestCase):
    def test_reported_failure_shape(self):
        # The shape that failed: [short, linked, >2,000-char block] + a new note.
        old = [read_obj("s" * 1034), read_obj("l" * 44, PLAIN, "https://example.com/pr"),
               read_obj("\n" + "q" * 3890)]
        note = "2099-01-01 (test): synthetic note."
        new = nt.build_append(old, note)
        self.assertEqual(joined(new), "".join(o["plain_text"] for o in old) + "\n" + note)
        self.assertEqual([utf16_units(c) for c in contents(new)], [1034, 44, 2000, 1891, len(note) + 1])
        self.assertEqual(new[1]["text"]["link"], {"url": "https://example.com/pr"})
        self.assertEqual(new[-1], {"type": "text", "text": {"content": "\n" + note}})
        for o in new:
            self.assertLessEqual(utf16_units(o["text"]["content"]), 2000)
        json.dumps(new, ensure_ascii=False).encode("utf-8")  # the request body encodes

    def test_new_text_is_split_the_same_way_with_nothing_lost_or_repeated(self):
        note = "".join(chr(ord("A") + i % 26) for i in range(7000)) + EMOJI * 700
        new = nt.build_append([read_obj("old")], note)
        self.assertEqual(joined(new), "old\n" + note)
        self.assertTrue(all(utf16_units(c) <= 2000 for c in contents(new)))
        self.assertFalse(any(has_lone_surrogate(c) for c in contents(new)))

    def test_empty_notes_gets_no_leading_newline(self):
        self.assertEqual(nt.build_append([], "first note"),
                         [{"type": "text", "text": {"content": "first note"}}])

    def test_exactly_100_objects_is_allowed(self):
        new = nt.build_append([read_obj("x") for _ in range(99)], "y")
        self.assertEqual(len(new), 100)

    def test_more_than_100_objects_is_refused_not_truncated(self):
        with self.assertRaises(nt.NotesLimitError) as cm:
            nt.build_append([read_obj("x") for _ in range(100)], "y")
        self.assertIn("101", str(cm.exception))
        self.assertIn("100", str(cm.exception))
        self.assertIn("Nothing was written", str(cm.exception))

    def test_guard_counts_the_pieces_after_splitting(self):
        # 60 objects on read, but each needs two pieces on write: 120 + 1.
        old = [read_obj("w" * 2500) for _ in range(60)]
        with self.assertRaises(nt.NotesLimitError) as cm:
            nt.build_append(old, "y")
        self.assertIn("121", str(cm.exception))
        # a long new note alone can trip it too
        with self.assertRaises(nt.NotesLimitError):
            nt.build_append([], "n" * (2000 * 100 + 1))

    def test_empty_text_is_refused(self):
        with self.assertRaises(nt.NotesLimitError):
            nt.build_append([read_obj("x")], "")

    def test_refuses_when_the_read_may_have_dropped_mentions(self):
        mention = {"type": "mention", "mention": {"type": "page", "page": {"id": "0" * 32}},
                   "annotations": dict(PLAIN), "plain_text": "A page", "href": None}
        self.assertEqual(len(nt.build_append([mention] * 24, "ok")), 25)
        with self.assertRaises(nt.NotesLimitError):
            nt.build_append([mention] * 25, "no")


if __name__ == "__main__":
    unittest.main()
