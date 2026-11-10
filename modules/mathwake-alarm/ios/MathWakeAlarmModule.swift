import ExpoModulesCore

// iOS stub: exact full-screen alarms are an Android-only feature.
// The JS layer checks `available` and always falls back to the
// expo-notifications scheduling path on iOS.
public class MathWakeAlarmModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MathWakeAlarm")

    AsyncFunction("getStatus") { () -> [String: Any] in
      return ["available": false, "reason": "unsupported-platform"]
    }

    AsyncFunction("scheduleAlarm") { (alarmId: String, triggerAtMs: Double, deepLink: String, timeHHMM: String, daysCsv: String, isRecurring: Bool, ringtoneUri: String) -> [String: Any] in
      return ["scheduled": false, "reason": "unsupported-platform"]
    }

    AsyncFunction("cancelAlarm") { (alarmId: String) -> Void in
    }

    AsyncFunction("dismissNotification") { (alarmId: String) -> Void in
    }

    AsyncFunction("dismissEventNotification") { (eventId: String, generation: String) -> Bool in
      return false
    }

    AsyncFunction("consumePendingAlarm") { () -> [String: Any]? in
      return nil
    }

    AsyncFunction("clearPendingAlarm") { (alarmId: String) -> Void in
    }

    AsyncFunction("ackPendingAlarm") { (eventId: String, generation: String) -> Bool in
      return false
    }

    AsyncFunction("openExactAlarmSettings") { () -> Bool in
      return false
    }

    AsyncFunction("openAppInfoSettings") { () -> Bool in
      return false
    }

    AsyncFunction("muteRing") { (eventId: String, generation: String) -> Bool in
      return false
    }

    AsyncFunction("stopRing") { (eventId: String, generation: String) -> Bool in
      return false
    }

    AsyncFunction("isRinging") { (eventId: String, generation: String) -> Bool in
      return false
    }

    AsyncFunction("getActiveAlarmId") { () -> String? in
      return nil
    }

    AsyncFunction("hasFutureAlarmSchedule") { (alarmId: String) -> Bool in
      return false
    }

    AsyncFunction("hasOtherLiveAlarmOccurrence") { (alarmId: String, eventId: String) -> Bool in
      return false
    }

    AsyncFunction("getActiveAlarmEvent") { () -> [String: String]? in
      return nil
    }

    AsyncFunction("getLiveAlarmIds") { () -> [String] in
      return []
    }

  }
}
