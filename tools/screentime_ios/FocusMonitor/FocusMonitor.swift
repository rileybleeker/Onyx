import DeviceActivity

final class FocusMonitor: DeviceActivityMonitor {
    override func intervalDidStart(for activity: DeviceActivityName) {
        super.intervalDidStart(for: activity)
        guard activity == FocusEnforcement.activity else { return }
        FocusEnforcement.reconcile()
    }
    override func intervalDidEnd(for activity: DeviceActivityName) {
        super.intervalDidEnd(for: activity)
        guard activity == FocusEnforcement.activity else { return }
        FocusEnforcement.reconcile()
    }
}
