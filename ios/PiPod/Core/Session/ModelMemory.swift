import Foundation

/// The model new pods start on: the one last chosen in any pod on this server — the way pi
/// itself starts each session on the model last picked. Without it every pod launched from
/// the phone opened on the provider's built-in default, which the account may not offer.
///
/// It applies only to pods this app has just launched and only while they have no
/// conversation: a pod launched anywhere else keeps the model it was given.
@MainActor
public enum ModelMemory {
    private static var freshPods: Set<String> = []
    private static var key: String { "pipod.lastModel." + Config.serverURL.absoluteString }

    public static func remember(_ model: ModelChoice) {
        UserDefaults.standard.set("\(model.provider)/\(model.modelId)", forKey: key)
    }

    /// Called once a launch is admitted.
    public static func launched(podID: String) {
        freshPods.insert(podID)
    }

    /// "provider/id" to start `podID` on, or nil when it is not a pod this app just launched
    /// or no model has been chosen on this server yet.
    public static func startingModel(podID: String) -> String? {
        freshPods.contains(podID) ? UserDefaults.standard.string(forKey: key) : nil
    }

    /// The pod has been started on its model, or no longer needs to be.
    public static func settled(podID: String) {
        freshPods.remove(podID)
    }
}
