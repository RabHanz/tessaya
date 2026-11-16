Pod::Spec.new do |s|
  s.name = 'T3PhoneAudio'
  s.version = '1.0.0'
  s.summary = 'Two-way PCM voice audio over the phone route for T3 Code.'
  s.author = 'T3 Tools'
  s.homepage = 'https://t3tools.com'
  s.platform = :ios, '18.0'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'AVFoundation'
end
