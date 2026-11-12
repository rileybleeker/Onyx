// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "FocusCore", products: [.library(name: "FocusCore", targets: ["FocusCore"])], targets: [.target(name: "FocusCore"), .testTarget(name: "FocusCoreTests", dependencies: ["FocusCore"])])
