// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "eden-bridge",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "eden-bridge", targets: ["EdenBridge"])],
    targets: [
        // Pure logic (wire format, auth, key mapping): unit-testable without permissions.
        .target(name: "EdenBridgeCore"),
        .executableTarget(
            name: "EdenBridge",
            dependencies: ["EdenBridgeCore"],
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("Network"),
                .linkedFramework("ApplicationServices"),
            ]
        ),
        .testTarget(name: "EdenBridgeCoreTests", dependencies: ["EdenBridgeCore"]),
    ]
)
