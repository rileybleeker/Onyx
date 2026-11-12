import XCTest
@testable import FocusCore

final class FocusExceptionTests: XCTestCase {
    func testAppOnlyExceptionIsRefused() {
        XCTAssertNotNil(FocusExceptions.validationError(appCount: 1, domainCount: 0, categoryCount: 0, confirmed: true))
    }
    func testWebsiteOnlyAndEmptyExceptionsAreRefused() {
        XCTAssertNotNil(FocusExceptions.validationError(appCount: 0, domainCount: 1, categoryCount: 0, confirmed: true))
        XCTAssertNotNil(FocusExceptions.validationError(appCount: 0, domainCount: 0, categoryCount: 0, confirmed: true))
    }
    func testBothSelectionsStillRequireExplicitConfirmation() {
        XCTAssertNotNil(FocusExceptions.validationError(appCount: 1, domainCount: 1, categoryCount: 0, confirmed: false))
        XCTAssertNil(FocusExceptions.validationError(appCount: 1, domainCount: 1, categoryCount: 0, confirmed: true))
    }
    func testWholeCategoriesAndExcessiveExceptionsAreRefused() {
        XCTAssertNotNil(FocusExceptions.validationError(appCount: 1, domainCount: 1, categoryCount: 1, confirmed: true))
        XCTAssertNotNil(FocusExceptions.validationError(appCount: 51, domainCount: 1, categoryCount: 0, confirmed: true))
        XCTAssertNotNil(FocusExceptions.validationError(appCount: 1, domainCount: 51, categoryCount: 0, confirmed: true))
    }
}
