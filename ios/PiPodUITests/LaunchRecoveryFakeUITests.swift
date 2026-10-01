import Foundation
import Network
import XCTest

/// A loopback-only, opt-in UI check of the client recovery wiring. It is not a
/// provider or model test. No credential or production endpoint is used.
final class LaunchRecoveryFakeUITests: XCTestCase {
    private let fakeToken = "pp-uitest-fake-token-not-secret"

    func testNotFoundResendsOnlyAfterExplicitContinueWithTheSameOperationID() throws {
        guard ProcessInfo.processInfo.environment["PIPOD_UI_FAKE_LAUNCH"] == "1" else {
            throw XCTSkip("Run explicitly with TEST_RUNNER_PIPOD_UI_FAKE_LAUNCH=1 and a Debug app")
        }
        continueAfterFailure = false
        let fixture = try LoopbackLaunchFixture(token: fakeToken)
        defer { fixture.stop() }
        guard let port = fixture.readyPort(timeout: 5) else {
            return XCTFail("Loopback fixture did not become ready")
        }
        let address = "http://127.0.0.1:\(port)"
        XCTAssertEqual(URL(string: address)?.host, "127.0.0.1")

        let app = XCUIApplication()
        app.launchArguments = [
            "-PIPOD_SERVER_URL", address, "-PIPOD_DEV_TOKEN", fakeToken,
        ]
        app.launch()
        defer { app.terminate() }
        XCTAssertTrue(fixture.waitFor(timeout: 15) { $0.meCount > 0 },
                      "The app did not contact the loopback /v1/me fixture (Debug override or ATS failure)")
        XCTAssertTrue(app.buttons["pods.new"].waitForExistence(timeout: 15))
        app.buttons["pods.new"].tap()
        let start = app.buttons["launch.submit"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        XCTAssertTrue(start.isEnabled)
        start.tap()
        XCTAssertTrue(fixture.waitFor(timeout: 15) { $0.posts.count == 1 && $0.statusReads > 0 },
                      "Expected one failed POST followed by a status GET")
        let continueButton = app.buttons["workstation.retry"]
        XCTAssertTrue(continueButton.waitForExistence(timeout: 15),
                      "not_found must offer explicit Continue rather than locking the launch")
        XCTAssertTrue(continueButton.isEnabled)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(
            format: "label CONTAINS %@", "server has no record"
        )).firstMatch.exists)
        capture(app, name: "fake-recovery-not-found")

        Thread.sleep(forTimeInterval: 3)
        XCTAssertEqual(fixture.snapshot().posts.count, 1,
                       "A status GET must not cause a launch POST by itself (observed for 3s)")
        fixture.armAdmission()
        continueButton.tap()
        XCTAssertTrue(fixture.waitFor(timeout: 15) { $0.posts.count >= 2 })
        let record = fixture.snapshot()
        XCTAssertEqual(record.posts.count, 2)
        XCTAssertEqual(record.posts.first, record.posts.last,
                       "Continue must reuse the original operation ID")
        XCTAssertEqual(record.statusReads, 1,
                       "No extra status GET should POST or consume the explicit recovery")
        XCTAssertTrue(app.descendants(matching: .any)
            .matching(identifier: "composer.field").firstMatch.waitForExistence(timeout: 20),
            "Fake admission should navigate directly to the conversation")
        capture(app, name: "fake-recovery-session")
        XCTAssertTrue(fixture.snapshot().violations.isEmpty, fixture.snapshot().violations.joined(separator: "; "))
        let log = fixture.snapshot().requests.joined(separator: "\n")
        let attachment = XCTAttachment(string: log)
        attachment.name = "fake-recovery-request-log"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func capture(_ app: XCUIApplication, name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}

/// One-request-per-connection HTTP fixture. Its listener belongs to the UI test
/// runner and is restricted to the simulator's loopback interface.
private final class LoopbackLaunchFixture: @unchecked Sendable {
    struct Snapshot {
        let meCount: Int
        let posts: [String]
        let statusReads: Int
        let violations: [String]
        let requests: [String]
    }

    private let token: String
    private let queue = DispatchQueue(label: "pipod.fake-launch-ui")
    private let listener: NWListener
    private let ready = DispatchSemaphore(value: 0)
    private var isReady = false
    private var meCount = 0
    private var posts: [String] = []
    private var statusReads = 0
    private var violations: [String] = []
    private var requests: [String] = []
    private var armed = false
    private var admitted = false
    private let podID = "018f0000-0000-7000-8000-000000000001"

    init(token: String) throws {
        self.token = token
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(
            host: .ipv4(IPv4Address("127.0.0.1")!), port: .any
        )
        listener = try NWListener(using: parameters, on: .any)
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.isReady = true
                self.ready.signal()
            case .failed:
                self.ready.signal()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            connection.start(queue: self.queue)
            self.read(connection, buffer: Data())
        }
        listener.start(queue: queue)
    }

    func readyPort(timeout: TimeInterval) -> UInt16? {
        guard ready.wait(timeout: .now() + timeout) == .success else { return nil }
        return queue.sync { isReady ? listener.port?.rawValue : nil }
    }

    func stop() { listener.cancel() }

    func armAdmission() { queue.sync { armed = true } }

    func snapshot() -> Snapshot {
        queue.sync {
            Snapshot(meCount: meCount, posts: posts, statusReads: statusReads,
                     violations: violations, requests: requests)
        }
    }

    func waitFor(timeout: TimeInterval, condition: (Snapshot) -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if condition(snapshot()) { return true }
            if Date() >= deadline { return false }
            Thread.sleep(forTimeInterval: 0.1)
        } while true
    }

    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] chunk, _, done, _ in
            guard let self else { connection.cancel(); return }
            var received = buffer
            if let chunk { received.append(chunk) }
            guard received.count <= 1024 * 1024 else { connection.cancel(); return }
            guard let boundary = received.range(of: Data("\r\n\r\n".utf8)) else {
                if done { connection.cancel() } else { self.read(connection, buffer: received) }
                return
            }
            let header = String(decoding: received[..<boundary.lowerBound], as: UTF8.self)
            let contentLength = header.components(separatedBy: "\r\n")
                .first { $0.lowercased().hasPrefix("content-length:") }
                .flatMap { Int($0.split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespaces) ?? "") } ?? 0
            guard contentLength >= 0, contentLength <= 1024 * 1024 else { connection.cancel(); return }
            let body = Data(received[boundary.upperBound...])
            guard body.count >= contentLength else {
                if done { connection.cancel() } else { self.read(connection, buffer: received) }
                return
            }
            let parts = header.components(separatedBy: "\r\n")
            let requestLine = parts.first?.split(separator: " ") ?? []
            guard requestLine.count >= 2 else { connection.cancel(); return }
            let method = String(requestLine[0])
            let path = String(requestLine[1]).components(separatedBy: "?")[0]
            let response = self.respond(method: method, path: path, header: header,
                                        body: Data(body.prefix(contentLength)))
            connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }

    private func respond(method: String, path: String, header: String, body: Data) -> String {
        requests.append("\(method) \(path)")
        if method == "GET" && path == "/v1/me" {
            meCount += 1
            if !header.lowercased().contains("authorization: bearer \(token.lowercased())") {
                violations.append("unexpected /me authorization")
                return answer(401, #"{"error":"unauthorized"}"#)
            }
            return answer(200, #"{"user":{"id":"u1","email":"fake@example.test"},"currentOrgId":"o1","permissions":["pods:launch"],"organization":{"id":"o1","alias":"fake","name":"Fake Org"}}"#)
        }
        if method == "GET" && path == "/v1/pods" {
            return answer(200, admitted ? "{\"pods\":[\(pod)]}" : #"{"pods":[]}"#)
        }
        if method == "GET" && path == "/v1/templates" {
            return answer(200, #"{"templates":[{"id":"018f0000-0000-7000-8000-000000000002","name":"Fake environment","status":"active","config":{},"createdAt":"2026-08-03T00:00:00Z","updatedAt":"2026-08-03T00:00:00Z"}]}"#)
        }
        if method == "GET", path.hasPrefix("/v1/launch-operations/") {
            statusReads += 1
            let operationID = String(path.dropFirst("/v1/launch-operations/".count))
            if let first = posts.first, first != operationID {
                violations.append("status read for a different operation")
            }
            return answer(200, admitted
                ? "{\"operationId\":\"\(operationID)\",\"state\":\"admitted\",\"launch\":\(launch)}"
                : "{\"operationId\":\"\(operationID)\",\"state\":\"not_found\"}")
        }
        if method == "POST" && path == "/v1/pods" {
            let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
            let operationID = json?["operationId"] as? String ?? ""
            if UUID(uuidString: operationID) == nil { violations.append("POST missing UUID operationId") }
            posts.append(operationID)
            requests[requests.count - 1] += " operationId=\(operationID)"
            if posts.count == 1 || !armed {
                if posts.count > 1 { violations.append("automatic POST before Continue") }
                return answer(503, #"{"error":"fake gateway unavailable"}"#)
            }
            if operationID != posts.first { violations.append("Continue changed operation ID") }
            admitted = true
            return answer(201, launch)
        }
        // Opening the conversation asks for a socket ticket. This fixture
        // deliberately has no live session; only this one admitted-pod write
        // is expected, and a 503 leaves the composer in its disconnected state.
        if method == "POST", admitted, path == "/v1/pods/\(podID)/ws-ticket" {
            return answer(503, #"{"error":"fake session unavailable"}"#)
        }
        if method != "GET" {
            violations.append("unexpected write: \(method) \(path)")
            return answer(500, #"{"error":"unexpected write"}"#)
        }
        return answer(404, #"{"error":"not found"}"#)
    }

    private var pod: String {
        "{\"id\":\"\(podID)\",\"userId\":\"u1\",\"name\":\"fake pod\",\"provider\":\"sandbox\",\"state\":\"active\",\"ready\":true,\"sandboxState\":\"started\",\"preparationPhase\":\"ready\",\"createdAt\":\"2026-08-03T00:00:00Z\"}"
    }

    private var launch: String {
        "{\"pod\":\(pod),\"report\":{\"clamps\":[],\"secretKeys\":[],\"warnings\":[]}}"
    }

    private func answer(_ code: Int, _ json: String) -> String {
        let reason = code == 200 ? "OK" : code == 201 ? "Created" : code == 401 ? "Unauthorized" : code == 404 ? "Not Found" : "Service Unavailable"
        return "HTTP/1.1 \(code) \(reason)\r\nContent-Type: application/json\r\nContent-Length: \(json.utf8.count)\r\nConnection: close\r\n\r\n\(json)"
    }
}
