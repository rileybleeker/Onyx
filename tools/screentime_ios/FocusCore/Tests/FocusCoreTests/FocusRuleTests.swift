import XCTest
@testable import FocusCore

final class FocusRuleTests: XCTestCase {
    var calendar: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "America/New_York")!; return c }
    func date(_ text: String) -> Date { ISO8601DateFormatter().date(from: text)! }
    func rule(_ mode: UnlockMode) -> FocusRule {
        var r = FocusRule(); r.enabled = true; r.mode = mode
        r.tasks = [FocusTask(title: "Example task")]; return r
    }
    func testDisabledAndUnconfiguredNeverShield() {
        XCTAssertFalse(FocusRule().shouldShield(at: date("2026-11-11T15:00:00Z"), calendar: calendar))
        var r = rule(.choose); XCTAssertNotNil(r.validationError)
        r.mode = .tasksOnly; r.tasks = []; XCTAssertNotNil(r.validationError)
    }
    func testNoonBoundary() {
        let r = rule(.timeOnly)
        XCTAssertTrue(r.shouldShield(at: date("2026-11-11T16:59:59Z"), calendar: calendar))
        XCTAssertFalse(r.shouldShield(at: date("2026-11-11T17:00:00Z"), calendar: calendar))
    }
    func testCombinationTruthTable() {
        for mode in [UnlockMode.both, .either, .timeOnly, .tasksOnly] {
            for done in [false, true] {
                for afterNoon in [false, true] {
                    var r = rule(mode)
                    r.tasks[0].completedDay = done ? "2026-11-11" : nil
                    let now = date(afterNoon ? "2026-11-11T18:00:00Z" : "2026-11-11T15:00:00Z")
                    let unlocked: Bool
                    switch mode {
                    case .both: unlocked = done && afterNoon
                    case .either: unlocked = done || afterNoon
                    case .timeOnly: unlocked = afterNoon
                    default: unlocked = done
                    }
                    XCTAssertEqual(r.shouldShield(at: now, calendar: calendar), !unlocked)
                }
            }
        }
    }
    func testDailyTaskResetAndDST() {
        var r = rule(.tasksOnly); r.tasks[0].completedDay = "2026-11-10"
        XCTAssertFalse(r.shouldShield(at: date("2026-11-11T04:59:59Z"), calendar: calendar))
        XCTAssertTrue(r.shouldShield(at: date("2026-11-11T05:00:00Z"), calendar: calendar))
        r.mode = .timeOnly
        XCTAssertFalse(r.shouldShield(at: date("2026-07-01T16:00:00Z"), calendar: calendar))
        XCTAssertTrue(r.shouldShield(at: date("2026-11-01T16:59:00Z"), calendar: calendar))
    }
    func testInvalidRulesFailOpenAndRoundTrip() throws {
        var r = rule(.both); r.unlockMinute = -1
        XCTAssertNotNil(r.validationError)
        XCTAssertFalse(r.shouldShield(at: Date(), calendar: calendar))
        r.unlockMinute = 720
        XCTAssertEqual(try JSONDecoder().decode(FocusRule.self, from: JSONEncoder().encode(r)), r)
    }
}
