"""orders_email_etl: status / order number / tracking / date / item parsing, store keys, and joining
emails into orders. Offline: every email is invented, every address uses reserved example domains,
and no address, phone number or real order appears here (the repo is public).

Run: python tests/test_orders_email_etl.py
"""
import os
import sys
import unittest
from datetime import date
from email.message import EmailMessage
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import orders_email_etl as o  # noqa: E402


def msg(subject, sender, date_hdr="Tue, 10 Mar 2026 15:00:00 +0000", to="Pat Example <pat@example.com>"):
    m = EmailMessage()
    m["Subject"], m["From"], m["Date"], m["To"] = subject, sender, date_hdr, to
    m["Message-ID"] = "<x@example.com>"
    return m


def ev(mid, when, status, **kw):
    base = dict(message_id=mid, received_at=when, parse_status="parsed", status=status, kind="merchant",
                sender_address="orders@store.example", merchant_key="store.example", merchant_name="Example Store",
                order_number=None, tracking=[], expected_date=None, items=[], item_count=None)
    base.update(kw)
    return base


class Status(unittest.TestCase):
    def cases(self, pairs):
        for subject, want in pairs:
            self.assertEqual(o.classify_status(subject, []), want, subject)

    def test_subjects(self):
        self.cases([
            ("Your Example LLC package was delivered", "delivered"),
            ("Your Order Has Been Delivered", "delivered"),
            ("Delivered: Blue Widget and 3 other items", "delivered"),
            ("Your order has arrived!", "delivered"),
            ("UPS Delivery Notification, Tracking Number 1Z999AA10123456784", "delivered"),
            ("Your order #1234 is out for delivery", "out_for_delivery"),
            ("Your package is running late", "delayed"),
            ("The delivery date for your order has changed", "delayed"),
            ("ATTENTION- your Example order is not on its way", "exception"),
            ("A shipment from order #1234 is on the way", "shipped"),
            ("Your order has shipped!", "shipped"),
            ("UPS Ship Notification, Tracking Number 1Z999AA10123456784", "shipped"),
            ("Your Order #1234 is confirmed", "ordered"),
            ("Thank you for your order!", "ordered"),
            ("Your order is ready to ship", "ordered"),
            ("ORDER SUCCESSFUL: Wellness is On the Way", "ordered"),
            ("Your order #1234 has been canceled", "canceled"),
        ])

    def test_not_order_updates(self):
        self.cases([
            ("Your order is coming soon", None),            # subscription reminder: next order not placed yet
            ("Your appointment is confirmed", None),
            ("Cheers, your reservation is confirmed", None),
            ("You've successfully canceled an item from your order ending in 8041.", None),
            ("Your order is ready for pick-up", None),
            ("Crowd favorites, nearby", None),
        ])

    def test_body_fallback_is_narrow(self):
        self.assertEqual(o.classify_status("Bulletproof Order 1234", ["Thank you for shopping with us!"]), "ordered")
        self.assertIsNone(o.classify_status("Monthly box", ["Delivered every month", "Every 30 Days"]))


class Identifiers(unittest.TestCase):
    def test_order_numbers(self):
        self.assertEqual(o.find_order_number("Your Order #2421016 is confirmed", []), "2421016")
        self.assertEqual(o.find_order_number("Order SH2001181701 confirmed", []), "SH2001181701")
        self.assertEqual(o.find_order_number("Your Store.com order 3571911 is on the way", []), "3571911")
        self.assertEqual(o.find_order_number("Thanks", ["Order #: 1005151278"]), "1005151278")
        self.assertEqual(o.find_order_number("Thanks", ["Order: MCEQOE0G-0001"]), "MCEQOE0G-0001")
        self.assertEqual(o.find_order_number("Delivered", ["Order number:", "K870649007"]), "K870649007")
        self.assertEqual(o.find_order_number("x", ["Order Number: 549250 | Order Date: 2026/11/06"]), "549250")
        self.assertIsNone(o.find_order_number("Your order is on the way", ["Order Date: 11/06/2026"]))
        self.assertIsNone(o.find_order_number("Your order is on the way", ["Tracking number 9400100000000000000000"]))

    def test_tracking_numbers(self):
        got = o.find_tracking(["Amazon Logistics US tracking number: TBA123456789012", "UPS 1Z999AA10123456784"], [], None)
        self.assertEqual({(t["number"], t["carrier"]) for t in got},
                         {("TBA123456789012", "Amazon"), ("1Z999AA10123456784", "UPS")})

    def test_usps_routing_prefix_is_stripped(self):
        # 420 + a ZIP code + the real number: the ZIP must not be stored.
        got = o.find_tracking(["Shipping method:", "Standard", "420000009400100000000000000000"], [], None)
        self.assertEqual([t["number"] for t in got], ["9400100000000000000000"])

    def test_fedex_needs_context(self):
        self.assertEqual(o.find_tracking(["Order details", "fedex # 123456789012"], [], None)[0]["carrier"], "FedEx")
        self.assertEqual(o.find_tracking(["Call 123456789012 for help"], [], None), [])

    def test_tracking_from_links(self):
        got = o.find_tracking([], ["https://www.example.com/r?U=https%3A%2F%2Ftrack.amazon.com%2Ftracking%2FTBA123456789012%3Fx%3D1"], "Amazon")
        self.assertEqual(got, [{"number": "TBA123456789012", "carrier": "Amazon"}])


class Dates(unittest.TestCase):
    A = date(2026, 3, 10)  # a Tuesday

    def test_expected_dates(self):
        f = lambda lines: o.find_expected_date("", lines, self.A)  # noqa: E731
        self.assertEqual(f(["Your package will be delivered on Saturday, March 14."]), date(2026, 3, 14))
        self.assertEqual(f(["Your package is now arriving Friday, March 13."]), date(2026, 3, 13))
        self.assertEqual(f(["Expected:", "March 20, 2026"]), date(2026, 3, 20))
        self.assertEqual(f(["Estimated Delivery Date:", "Thursday, 03/12/2026"]), date(2026, 3, 12))
        self.assertEqual(f(["Arriving tomorrow"]), date(2026, 3, 11))
        self.assertIsNone(f(["Expected:", "-"]))
        self.assertIsNone(f(["Delivered every month"]))

    def test_year_rolls_over(self):
        self.assertEqual(o.parse_date_text("January 3", date(2026, 12, 28)), date(2027, 1, 3))


class Items(unittest.TestCase):
    def test_layouts(self):
        names, _ = o.find_items("", ["Items in this shipment", "Peak Widget × 1", "Berry", "Every 30 Days"])
        self.assertEqual(names, ["Peak Widget"])
        names, _ = o.find_items("", ["Items ordered", "Peak Widget", "Berry", "rechargeId: abc123", "x 1", "$42.50"])
        self.assertEqual(names, ["Peak Widget"])
        names, _ = o.find_items("", ["YOUR ITEMS:", "Alpha Caps", "Quantity: 1", "Price: 12.4", "Beta Tabs", "Quantity: 1"])
        self.assertEqual(names, ["Alpha Caps", "Beta Tabs"])
        names, count = o.find_items("Delivered: Blue Widget Liq... and 6 other items", [])
        self.assertEqual((names, count), (["Blue Widget Liq"], 7))

    def test_never_an_address_name_or_tracking_line(self):
        lines = ["Items ordered", "Pat Example", "x 1", "Shipping Address", "123 Example Street NE", "x 1",
                 "Order details", "fedex # 123456789012", "Quantity: 1", "Unit 5", "x 2", "Springfield, ZZ 00000", "x 1"]
        names, _ = o.find_items("", lines, recipient="Pat Example")
        self.assertEqual(names, [])


class Stores(unittest.TestCase):
    def test_keys(self):
        self.assertEqual(o.merchant_key("no-reply@info.thorne.example"), "thorne.example")
        self.assertEqual(o.merchant_key("store+66591064385@t.shopifyemail.com"), "shopify:66591064385")
        self.assertEqual(o.merchant_key("no-reply@acme.aftershiptracking.com"), "acme.com")
        self.assertEqual(o.merchant_key("x@shop.example.co.uk"), "example.co.uk")

    def test_excluded_and_carriers(self):
        self.assertTrue(o.is_excluded_sender("noreply@uber.com"))
        self.assertTrue(o.is_excluded_sender("no-reply@business.amazon.com"))
        self.assertFalse(o.is_excluded_sender("no-reply@shipping.amazon.com"))
        self.assertEqual(o.carrier_sender("no-reply@shipping.amazon.com"), ("Amazon", "marketplace"))
        self.assertEqual(o.carrier_sender("pkginfo@ups.com"), ("UPS", "carrier"))
        self.assertIsNone(o.carrier_sender("orders@store.example"))

    def test_display_name_drops_addresses_and_boilerplate(self):
        self.assertEqual(o.merchant_display("Acme Customer Care", "care@acme.example"), "Acme")
        self.assertEqual(o.merchant_display("Pat Rep (pat@vendor.example)", "system@sent-via.netsuite.com"), "Pat Rep")
        self.assertEqual(o.merchant_display("Lenovo Tracking", "x@lenovo.aftershiptracking.com"), "Lenovo")

    def test_gmail_query_excludes_promotions_and_food(self):
        q = o.gmail_query(date(2026, 3, 1))
        self.assertIn("-category:promotions", q)
        self.assertIn("-from:uber.com", q)
        self.assertIn("after:2026/03/01", q)


class ParseMessage(unittest.TestCase):
    def test_amazon_shipping_email(self):
        m = msg("Your package from Example Nutrition LLC has shipped", "Amazon <no-reply@shipping.amazon.com>")
        ev_ = o.parse_message(m, ["Your package from Example Nutrition LLC is on the way. Your package will be delivered on Saturday, March 14."],
                              ["https://track.amazon.com/tracking/TBA123456789012?x=1"])
        self.assertEqual(ev_["parse_status"], "parsed")
        self.assertEqual((ev_["kind"], ev_["merchant_name"], ev_["status"], ev_["expected_date"]),
                         ("marketplace", "Example Nutrition", "shipped", "2026-03-14"))
        self.assertEqual(ev_["tracking"], [{"number": "TBA123456789012", "carrier": "Amazon"}])

    def test_marketing_without_numbers_is_ignored(self):
        for subject in ("Your W-2 has arrived", "Peachtree season has arrived", "Fresh flowers, delivered."):
            self.assertEqual(o.parse_message(msg(subject, "Promo <hi@promo.example>"), ["Shop now"], [])["parse_status"], "ignored", subject)

    def test_orderish_subject_without_numbers_is_kept(self):
        e = o.parse_message(msg("Your Example order has been delivered.", "Example <hello@example.com>"), ["Great news"], [])
        self.assertEqual((e["parse_status"], e["status"], e["merchant_key"]), ("parsed", "delivered", "example.com"))


class BuildOrders(unittest.TestCase):
    def test_store_and_amazon_emails_join_by_tracking(self):
        trk = [{"number": "TBA123456789012", "carrier": "Amazon"}]
        rows = o.build_orders([
            ev("a", "2026-03-01T10:00:00+00:00", "ordered", order_number="1001", items=["Peak Widget"]),
            ev("b", "2026-03-02T10:00:00+00:00", "shipped", order_number="1001", tracking=trk),
            ev("c", "2026-03-03T10:00:00+00:00", "delivered", kind="marketplace", sender_address="no-reply@shipping.amazon.com",
               merchant_key=None, merchant_name="Example Store", tracking=trk),
        ])
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual((r["order_key"], r["status"], r["event_count"]), ("o:store.example:1001", "delivered", 3))
        self.assertIn("t:TBA123456789012", r["aliases"])
        self.assertEqual(r["tracking"][0]["delivered"], True)
        self.assertEqual(r["items"], ["Peak Widget"])

    def test_delivered_email_with_another_number_joins_the_open_order(self):
        rows = o.build_orders([
            ev("a", "2026-03-01T10:00:00+00:00", "shipped", order_number="9033549",
               tracking=[{"number": "9400100000000000000000", "carrier": "USPS"}]),
            ev("b", "2026-03-05T10:00:00+00:00", "delivered", order_number="1780462326273"),
        ])
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["order_key"], rows[0]["status"]), ("o:store.example:9033549", "delivered"))

    def test_untracked_amazon_emails_join_by_store_name(self):
        rows = o.build_orders([
            ev("a", "2026-03-01T10:00:00+00:00", "shipped", order_number="1001", merchant_name="Example Nutrition",
               tracking=[{"number": "9400100000000000000000", "carrier": "USPS"}]),
            ev("b", "2026-03-03T10:00:00+00:00", "delivered", kind="marketplace", sender_address="no-reply@shipping.amazon.com",
               merchant_key=None, merchant_name="Example Nutrition"),
        ])
        self.assertEqual([r["status"] for r in rows], ["delivered"])

    def test_a_second_delivery_never_lands_on_a_delivered_order(self):
        rows = o.build_orders([
            ev("a", "2026-03-01T10:00:00+00:00", "delivered", order_number="1001"),
            ev("b", "2026-03-05T10:00:00+00:00", "delivered"),
        ])
        self.assertEqual(len(rows), 2)

    def test_partial_delivery(self):
        rows = o.build_orders([
            ev("a", "2026-03-01T10:00:00+00:00", "shipped", order_number="1001", tracking=[{"number": "1Z999AA10123456784", "carrier": "UPS"}]),
            ev("b", "2026-03-01T11:00:00+00:00", "shipped", order_number="1001", tracking=[{"number": "1Z999AA10123456791", "carrier": "UPS"}]),
            ev("c", "2026-03-03T10:00:00+00:00", "delivered", tracking=[{"number": "1Z999AA10123456784", "carrier": "UPS"}],
               kind="carrier", sender_address="mcinfo@ups.com", merchant_key=None),
        ])
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["status"], rows[0]["partially_delivered"]), ("shipped", True))

    def test_delay_after_shipping_is_an_issue_until_delivered(self):
        rows = o.build_orders([
            ev("a", "2026-03-01T10:00:00+00:00", "shipped", order_number="1001", expected_date="2026-03-04"),
            ev("b", "2026-03-04T10:00:00+00:00", "delayed", order_number="1001", expected_date="2026-03-06"),
        ])
        self.assertEqual((rows[0]["status"], rows[0]["issue"], rows[0]["expected_date"]), ("shipped", "delayed", "2026-03-06"))

    def test_confirms_delivery_needs_a_habit_of_delivery_emails(self):
        evs = []
        for i in range(4):   # four old orders, one delivered email: 25 %
            day = f"2026-01-{i * 5 + 1:02d}T10:00:00+00:00"
            evs.append(ev(f"s{i}", day, "shipped", order_number=f"{2000 + i}"))
            if i == 0:
                evs.append(ev(f"d{i}", f"2026-01-{i * 5 + 3:02d}T10:00:00+00:00", "delivered", order_number=f"{2000 + i}"))
        evs.append(ev("new", "2026-03-01T10:00:00+00:00", "shipped", order_number="3000"))
        rows = {r["order_key"]: r for r in o.build_orders(evs)}
        self.assertFalse(rows["o:store.example:3000"]["confirms_delivery"])
        evs2 = [e for e in evs] + [ev(f"d{i}", f"2026-01-{i * 5 + 3:02d}T10:00:00+00:00", "delivered", order_number=f"{2000 + i}")
                                   for i in (1, 2)]
        rows2 = {r["order_key"]: r for r in o.build_orders(evs2)}
        self.assertTrue(rows2["o:store.example:3000"]["confirms_delivery"])

    def test_deterministic(self):
        evs = [ev("a", "2026-03-01T10:00:00+00:00", "ordered", order_number="1001"),
               ev("b", "2026-03-02T10:00:00+00:00", "shipped", order_number="1001")]
        self.assertEqual(o.build_orders(evs), o.build_orders(list(reversed(evs))))


class ReviewFindings(unittest.TestCase):
    """Regressions for the 2026-11-12 review (numbered as in that review)."""

    def test_1_platform_and_direct_store_emails_never_share_a_key(self):
        rows = o.build_orders([
            ev("a", "2026-03-01T10:00:00+00:00", "ordered", sender_address="orders@thorne.example",
               merchant_key="thorne.example", merchant_name="Thorne", order_number="1234"),
            ev("b", "2026-03-02T10:00:00+00:00", "shipped", sender_address="x@narvar.com",
               merchant_key="name:thorne", merchant_name="Thorne", order_number="1234",
               tracking=[{"number": "1Z999AA10123456784", "carrier": "UPS"}]),
        ])
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["order_key"], rows[0]["status"]), ("o:thorne.example:1234", "shipped"))
        self.assertEqual(len({r["order_key"] for r in rows}), len(rows))

    def test_1_platform_email_first_still_joins(self):
        rows = o.build_orders([
            ev("b", "2026-03-01T10:00:00+00:00", "shipped", sender_address="x@narvar.com",
               merchant_key="name:thorne", merchant_name="Thorne", order_number="1234",
               tracking=[{"number": "1Z999AA10123456784", "carrier": "UPS"}]),
            ev("a", "2026-03-02T10:00:00+00:00", "delivered", sender_address="orders@thorne.example",
               merchant_key="thorne.example", merchant_name="Thorne", order_number="1234"),
        ])
        self.assertEqual([r["status"] for r in rows], ["delivered"])

    def test_2_raw_8bit_and_unknown_charset_headers_do_not_raise(self):
        raw = (b"From: Caf\xc3\xa9 Shop <orders@cafe.example>\r\nSubject: =?x-unknown?Q?Your_order_=231234_has_shipped?=\r\n"
               b"Date: Tue, 10 Mar 2026 15:00:00 +0000\r\nMessage-ID: <m1@cafe.example>\r\nContent-Type: text/plain; charset=x-unknown\r\n\r\n"
               b"Order #1234 tracking number 1Z999AA10123456784\r\n")
        m = o.parse_bytes(raw)
        e = o.parse_message(m, o.message_lines(m), o.html_hrefs(m))
        self.assertIsNotNone(e["received_at"])
        self.assertIn(e["parse_status"], ("parsed", "ignored"))
        self.assertIsInstance(o.safe_hdr(m, "From"), str)

    def test_3_own_mail_is_excluded_from_the_search(self):
        q = o.gmail_query(date(2026, 3, 1))
        for part in ("-in:sent", "-in:drafts", "-from:me"):
            self.assertIn(part, q)

    def test_4_delivered_without_numbers_does_not_pick_an_unshipped_or_ambiguous_order(self):
        trk = [{"number": "TBA123456789012", "carrier": "Amazon"}]
        rows = o.build_orders([
            ev("a1", "2026-03-02T10:00:00+00:00", "shipped", order_number="A1", tracking=trk, items=["Blue Widget"]),
            ev("b1", "2026-03-03T10:00:00+00:00", "ordered", order_number="B22", items=["Red Gadget"]),
            ev("d", "2026-03-04T10:00:00+00:00", "delivered", items=["Blue Widget"]),
        ])
        by = {r["order_number"]: r for r in rows if r["order_number"]}
        self.assertEqual(by["A1"]["status"], "delivered")
        self.assertEqual(by["B22"]["status"], "ordered")

    def test_4_two_shipped_orders_and_no_item_clue_take_the_oldest_first(self):
        evs = [
            ev("a", "2026-03-01T10:00:00+00:00", "shipped", order_number="1111", tracking=[{"number": "1Z999AA10123456784", "carrier": "UPS"}]),
            ev("b", "2026-03-02T10:00:00+00:00", "shipped", order_number="2222", tracking=[{"number": "1Z999AA10123456791", "carrier": "UPS"}]),
            ev("d", "2026-03-04T10:00:00+00:00", "delivered"),
        ]
        by = {r["order_number"]: r["status"] for r in o.build_orders(evs)}
        self.assertEqual((by["1111"], by["2222"]), ("delivered", "shipped"))
        by = {r["order_number"]: r["status"] for r in o.build_orders(evs + [ev("e", "2026-03-05T10:00:00+00:00", "delivered")])}
        self.assertEqual((by["1111"], by["2222"]), ("delivered", "delivered"))

    def test_4_item_names_beat_age(self):
        rows = o.build_orders([
            ev("a", "2026-03-01T10:00:00+00:00", "shipped", order_number="1111", items=["Blue Widget"],
               tracking=[{"number": "1Z999AA10123456784", "carrier": "UPS"}]),
            ev("b", "2026-03-02T10:00:00+00:00", "shipped", order_number="2222", items=["Red Gadget"],
               tracking=[{"number": "1Z999AA10123456791", "carrier": "UPS"}]),
            ev("d", "2026-03-04T10:00:00+00:00", "delivered", items=["Red Gadget"]),
        ])
        by = {r["order_number"]: r["status"] for r in rows}
        self.assertEqual((by["1111"], by["2222"]), ("shipped", "delivered"))

    def test_duplicate_delivery_confirmation_joins_the_delivered_order(self):
        rows = o.build_orders([
            ev("a", "2026-03-01T10:00:00+00:00", "shipped", order_number="1111",
               tracking=[{"number": "9400100000000000000000", "carrier": "USPS"}]),
            ev("b", "2026-03-03T15:00:00+00:00", "delivered", order_number="1111"),
            ev("c", "2026-03-03T16:00:00+00:00", "delivered", kind="marketplace", sender_address="no-reply@shipping.amazon.com",
               merchant_key=None, merchant_name="Example Store"),
        ])
        self.assertEqual(len(rows), 1)

    def test_branded_platform_sender_name_becomes_the_store(self):
        m = msg("ORDER SUCCESSFUL: Wellness is On the Way", "Example Herbs <no-reply@t1.rechargemail.com>")
        e = o.parse_message(m, ["Thank you for your order"], [])
        self.assertEqual((e["merchant_key"], e["merchant_name"]), ("name:exampleherbs", "Example Herbs"))
        m = msg("Your order is on the way", "Pat Rep <system@sent-via.netsuite.com>")
        e = o.parse_message(m, [], [])
        self.assertNotEqual(e["merchant_name"], "Pat Rep")

    def test_5_stale_expected_date_is_dropped_after_out_for_delivery(self):
        rows = o.build_orders([
            ev("a", "2026-03-01T10:00:00+00:00", "shipped", order_number="1001", expected_date="2026-03-04",
               tracking=[{"number": "1Z999AA10123456784", "carrier": "UPS"}]),
            ev("b", "2026-03-05T10:00:00+00:00", "out_for_delivery", tracking=[{"number": "1Z999AA10123456784", "carrier": "UPS"}],
               kind="carrier", sender_address="mcinfo@ups.com", merchant_key=None),
            ev("c", "2026-03-07T10:00:00+00:00", "out_for_delivery", tracking=[{"number": "1Z999AA10123456784", "carrier": "UPS"}],
               kind="carrier", sender_address="mcinfo@ups.com", merchant_key=None),
        ])
        r = rows[0]
        self.assertEqual((r["status"], r["expected_date"], r["out_for_delivery_at"][:10]), ("out_for_delivery", None, "2026-03-07"))

    def test_6_delay_before_shipping_stays_ordered(self):
        rows = o.build_orders([
            ev("a", "2026-03-01T10:00:00+00:00", "ordered", order_number="1001"),
            ev("b", "2026-03-02T10:00:00+00:00", "delayed", order_number="1001"),
        ])
        self.assertEqual((rows[0]["status"], rows[0]["issue"], rows[0]["shipped_at"]), ("ordered", "delayed", None))

    def test_7_subject_rules(self):
        cases = [("FedEx Shipment 123456789012 Delivered", "delivered"), ("Shipment Delivered", "delivered"),
                 ("Shipment canceled", "canceled"), ("Your order has been delivered. Leave a review!", "delivered"),
                 ("Review your recent order", None), ("Rate your purchase", None)]
        for subject, want in cases:
            self.assertEqual(o.classify_status(subject, []), want, subject)

    def test_8_ignored_mail_keeps_no_subject_or_sender_and_amounts_are_scrubbed(self):
        e = o.parse_message(msg("Your payment of $84.10 has been confirmed", "Billing <billing@power.example>"), [], [])
        self.assertEqual((e["parse_status"], e["subject"], e["sender_address"], e["sender_name"]), ("ignored", None, "", None))
        e = o.parse_message(msg("Your order #1234 of $54.99 has shipped", "Store <orders@store.example>"), [], [])
        self.assertEqual(e["parse_status"], "parsed")
        self.assertNotIn("54.99", e["subject"])

    def test_8_item_names_never_carry_prices_places_or_the_recipient(self):
        names, _ = o.find_items("", ["Items ordered", "Blue Widget - $12.99", "x 1"])
        self.assertEqual(names, [])
        names, _ = o.find_items("", ["Hi Pat,", "Items ordered", "Pat Example", "x 1"], recipient="")
        self.assertEqual(names, [])
        names, _ = o.find_items("", ["Items ordered", "Springfield, IL", "x 1"])
        self.assertEqual(names, [])
        names, _ = o.find_items("", ["Ship to", "Some Person", "x 1"])
        self.assertEqual(names, [])
        names, _ = o.find_items("", ["Items ordered", "Body Wash 30.6 oz", "x 1"])
        self.assertEqual(names, ["Body Wash 30.6 oz"])

    def test_9_every_email_keeps_an_alias_so_marks_survive_a_key_change(self):
        first = o.build_orders([ev("only", "2026-03-01T10:00:00+00:00", "shipped")])
        old_key = first[0]["order_key"]
        self.assertTrue(old_key.startswith("m:"))
        later = o.build_orders([ev("only", "2026-03-01T10:00:00+00:00", "shipped"),
                                ev("num", "2026-03-03T10:00:00+00:00", "delivered", order_number="77881")])
        self.assertEqual(len(later), 1)
        self.assertIn(old_key, later[0]["aliases"])

    def test_10_bare_hash_after_order_number_label(self):
        self.assertIsNone(o.find_order_number("x", ["Order number:", "#"]))

    def test_14_weekday_words(self):
        self.assertIsNone(o.parse_date_text("monthly", date(2026, 3, 10)))
        self.assertEqual(o.parse_date_text("Thurs", date(2026, 3, 10)), date(2026, 3, 12))


if __name__ == "__main__":
    unittest.main()
