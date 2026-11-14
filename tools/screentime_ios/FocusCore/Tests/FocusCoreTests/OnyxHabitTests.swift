import XCTest
@testable import FocusCore

/// Synthetic habits and dates only.
final class OnyxHabitTests: XCTestCase {
    var calendar: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "America/New_York")!; return c }
    func date(_ text: String) -> Date { ISO8601DateFormatter().date(from: text)! }

    // 2026-11-11 in New York: 15:00Z = 10:00 (before noon), 18:00Z = 13:00 (after noon).
    var morning: Date { date("2026-11-11T15:00:00Z") }
    var afternoon: Date { date("2026-11-11T18:00:00Z") }
    let today = "2026-11-11"

    func rule(_ mode: UnlockMode = .timeOnly) -> FocusRule {
        var r = FocusRule(); r.enabled = true; r.mode = mode
        if mode != .timeOnly { r.tasks = [FocusTask(title: "Example task")] }
        return r
    }

    func state(_ onyxRule: OnyxUnlockRule, done: [Bool], day: String = "2026-11-11", error: String? = nil) -> OnyxHabitState {
        let habits = done.enumerated().map { OnyxHabit(name: "Example habit \($0.offset + 1)", done: $0.element) }
        var s = OnyxHabitState()
        s.recordSuccess(OnyxHabitStatus(day: day, rule: onyxRule, habits: habits, fetchedAt: date("2026-11-11T14:00:00Z")))
        if let error { s.recordFailure(error, at: date("2026-11-11T14:30:00Z")) }
        return s
    }

    func testDecisionTableBothRules() {
        for done in [false, true] {
            for timeReady in [false, true] {
                XCTAssertEqual(OnyxUnlock.shouldUnlock(rule: .or, habitsDone: done, timeReady: timeReady, configPresent: true), done || timeReady)
                XCTAssertEqual(OnyxUnlock.shouldUnlock(rule: .and, habitsDone: done, timeReady: timeReady, configPresent: true), done && timeReady)
            }
        }
    }

    func testUnknownAndNoHabitsAreTimeOnlyUnderBothRules() {
        for onyxRule in [OnyxUnlockRule.or, .and] {
            for timeReady in [false, true] {
                XCTAssertEqual(OnyxUnlock.shouldUnlock(rule: onyxRule, habitsDone: nil, timeReady: timeReady, configPresent: true), timeReady)
                for done in [Bool?.none, true, false] {
                    XCTAssertEqual(OnyxUnlock.shouldUnlock(rule: onyxRule, habitsDone: done, timeReady: timeReady, configPresent: false), timeReady)
                }
            }
        }
    }

    func testNoStateOrNoHabitsBehavesExactlyLikeTheOldRule() {
        let noHabits = state(.and, done: [])
        for mode in [UnlockMode.timeOnly, .tasksOnly, .both, .either] {
            for now in [morning, afternoon] {
                let r = rule(mode)
                let old = r.shouldShield(at: now, calendar: calendar)
                XCTAssertEqual(r.shouldShield(at: now, calendar: calendar, onyx: nil), old)
                XCTAssertEqual(r.shouldShield(at: now, calendar: calendar, onyx: OnyxHabitState()), old)
                XCTAssertEqual(r.shouldShield(at: now, calendar: calendar, onyx: noHabits), old)
            }
        }
        XCTAssertEqual(OnyxHabitState().gate(today: today), .notConfigured)
        XCTAssertEqual(noHabits.gate(today: today), .notConfigured)
        // A failed first check with no earlier answer is still "not configured".
        var failedFirst = OnyxHabitState(); failedFirst.recordFailure("offline", at: morning)
        XCTAssertEqual(failedFirst.gate(today: today), .notConfigured)
    }

    func testOrRuleUnlocksEarlyWhenHabitsDone() {
        let r = rule()
        XCTAssertTrue(r.shouldShield(at: morning, calendar: calendar, onyx: state(.or, done: [true, false])))
        XCTAssertFalse(r.shouldShield(at: morning, calendar: calendar, onyx: state(.or, done: [true, true])))
        XCTAssertFalse(r.shouldShield(at: afternoon, calendar: calendar, onyx: state(.or, done: [false, false])))
    }

    func testAndRuleStaysBlockedAfterTheTimeUntilHabitsDone() {
        let r = rule()
        XCTAssertTrue(r.shouldShield(at: morning, calendar: calendar, onyx: state(.and, done: [true, true])))
        XCTAssertTrue(r.shouldShield(at: afternoon, calendar: calendar, onyx: state(.and, done: [true, false])))
        XCTAssertFalse(r.shouldShield(at: afternoon, calendar: calendar, onyx: state(.and, done: [true, true])))
    }

    func testFailedCheckNeverBlocksPastTheUnlockTime() {
        let r = rule()
        let failed = state(.and, done: [false], error: "offline")
        XCTAssertEqual(failed.gate(today: today), .unknown(.checkFailed))
        // Time-only: blocked before the time, open after it, even under AND.
        XCTAssertTrue(r.shouldShield(at: morning, calendar: calendar, onyx: failed))
        XCTAssertFalse(r.shouldShield(at: afternoon, calendar: calendar, onyx: failed))
        // OR with a failed check cannot unlock early.
        XCTAssertTrue(r.shouldShield(at: morning, calendar: calendar, onyx: state(.or, done: [false], error: "offline")))
    }

    func testFailedCheckKeepsADoneConfirmedToday() {
        let r = rule()
        let s = state(.or, done: [true], error: "offline")
        XCTAssertEqual(s.gate(today: today), .known(rule: .or, done: true))
        XCTAssertFalse(r.shouldShield(at: morning, calendar: calendar, onyx: s))
        // The last good answer survives the failure and the error is kept for the screen.
        XCTAssertEqual(s.status?.habits.count, 1)
        XCTAssertEqual(s.lastError, "offline")
    }

    func testAnswerForAnotherDayIsTimeOnly() {
        let r = rule()
        // Yesterday's "all done" does not unlock this morning (next-day reset)...
        let yesterdayDone = state(.or, done: [true], day: "2026-11-10")
        XCTAssertEqual(yesterdayDone.gate(today: today), .unknown(.otherDay))
        XCTAssertTrue(r.shouldShield(at: morning, calendar: calendar, onyx: yesterdayDone))
        // ...and yesterday's "not done" does not block this afternoon under AND.
        let yesterdayNotDone = state(.and, done: [false], day: "2026-11-10")
        XCTAssertFalse(r.shouldShield(at: afternoon, calendar: calendar, onyx: yesterdayNotDone))
        // Midnight: the same stored answer stops counting when the phone's day changes.
        let done = state(.or, done: [true])
        XCTAssertFalse(r.shouldShield(at: date("2026-11-12T04:59:00Z"), calendar: calendar, onyx: done))
        XCTAssertTrue(r.shouldShield(at: date("2026-11-12T05:00:00Z"), calendar: calendar, onyx: done))
    }

    func testOnyxHabitsReplaceThePhoneTaskList() {
        // Phone mode "tasks only" with an unticked local task: once Onyx habits are chosen they decide.
        let r = rule(.tasksOnly)
        XCTAssertTrue(r.shouldShield(at: afternoon, calendar: calendar))
        XCTAssertFalse(r.shouldShield(at: afternoon, calendar: calendar, onyx: state(.or, done: [false])))
        XCTAssertFalse(r.shouldShield(at: morning, calendar: calendar, onyx: state(.or, done: [true])))
    }

    func testDisabledOrInvalidRuleNeverShields() {
        var r = rule(); r.enabled = false
        XCTAssertFalse(r.shouldShield(at: morning, calendar: calendar, onyx: state(.and, done: [false])))
        r.enabled = true; r.unlockMinute = -1
        XCTAssertFalse(r.shouldShield(at: morning, calendar: calendar, onyx: state(.and, done: [false])))
    }

    func testParseAcceptsTheRouteAnswer() throws {
        let json = #"{"behavioral_date":"2026-11-11","rule":"and","config_present":true,"habits":[{"name":"Example habit 1","done":true},{"name":"Example habit 2","done":false}],"habits_done":false}"#
        let status = try OnyxHabitStatus.parse(Data(json.utf8), fetchedAt: morning)
        XCTAssertEqual(status.day, "2026-11-11")
        XCTAssertEqual(status.rule, .and)
        XCTAssertEqual(status.habits, [OnyxHabit(name: "Example habit 1", done: true), OnyxHabit(name: "Example habit 2", done: false)])
        XCTAssertFalse(status.allDone)
        XCTAssertEqual(status.outstanding, ["Example habit 2"])
        XCTAssertEqual(status.fetchedAt, morning)

        let none = try OnyxHabitStatus.parse(Data(#"{"behavioral_date":"2026-11-11","rule":"or","config_present":false,"habits":[],"habits_done":false}"#.utf8), fetchedAt: morning)
        XCTAssertTrue(none.habits.isEmpty)
        XCTAssertFalse(none.allDone)
    }

    func testParseRefusesAnythingElse() {
        let bad = [
            "",
            "not json",
            #"{"error":"status unavailable","step":"config"}"#,
            #"{"behavioral_date":"2026-11-11","rule":"xor","habits":[]}"#,
            #"{"behavioral_date":"11/11/2026","rule":"or","habits":[]}"#,
            #"{"behavioral_date":"2026-11-1","rule":"or","habits":[]}"#,
            #"{"behavioral_date":"2026-11-11","rule":"or"}"#,
            #"{"behavioral_date":"2026-11-11","rule":"or","habits":[{"name":"Example habit 1"}]}"#,
            #"{"behavioral_date":"2026-11-11","rule":"or","habits":[{"name":"Example habit 1","done":"yes"}]}"#,
        ]
        for text in bad {
            XCTAssertThrowsError(try OnyxHabitStatus.parse(Data(text.utf8), fetchedAt: morning), text)
        }
        let many = (1...21).map { #"{"name":"Example habit \#($0)","done":false}"# }.joined(separator: ",")
        XCTAssertThrowsError(try OnyxHabitStatus.parse(Data(#"{"behavioral_date":"2026-11-11","rule":"or","habits":[\#(many)]}"#.utf8), fetchedAt: morning))
    }

    func testStateRoundTripsAndOldFilesDecode() throws {
        let s = state(.and, done: [true, false], error: "offline")
        XCTAssertEqual(try JSONDecoder().decode(OnyxHabitState.self, from: JSONEncoder().encode(s)), s)
        XCTAssertEqual(try JSONDecoder().decode(OnyxHabitState.self, from: Data("{}".utf8)), OnyxHabitState())
    }
}
