# Match Rust's +crt-static MSVC targets. CMP0091 makes CMake honor the runtime
# setting instead of selecting the dynamic CRT by default.
set(CMAKE_POLICY_DEFAULT_CMP0091 NEW)
set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreaded)
