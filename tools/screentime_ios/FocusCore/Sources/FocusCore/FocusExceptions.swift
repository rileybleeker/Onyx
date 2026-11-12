/// Validates exception completeness without inspecting Apple's opaque tokens.
/// The user must separately confirm that both selections actually represent LinkedIn.
public enum FocusExceptions {
    public static func validationError(appCount: Int, domainCount: Int, categoryCount: Int, confirmed: Bool) -> String? {
        guard appCount > 0, domainCount > 0 else {
            return "Select both the LinkedIn app and its website in Allowed."
        }
        guard categoryCount == 0 else {
            return "Choose individual allowed apps and websites, not whole allowed categories."
        }
        guard appCount <= 50, domainCount <= 50 else {
            return "Select at most 50 allowed apps and 50 allowed websites."
        }
        guard confirmed else {
            return "Confirm that Allowed includes both the LinkedIn app and its website."
        }
        return nil
    }
}
