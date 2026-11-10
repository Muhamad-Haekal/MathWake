Pod::Spec.new do |s|
  s.name           = 'MathWakeAlarm'
  s.version        = '1.0.0'
  s.summary        = 'Exact alarms with full-screen intent for MathWake (Android implementation; iOS stub)'
  s.description    = 'Schedules exact Android alarms that wake the device and open the MathWake challenge.'
  s.license        = { :type => 'MIT' }
  s.author         = 'MathWake'
  s.homepage       = 'https://example.com/mathwake'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://example.com/mathwake.git', :tag => s.version.to_s }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
  s.source_files = "**/*.{h,m,swift}"
end