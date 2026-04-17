#include <napi.h>
#include <fstream>
#include <sstream>
#include <string>

// Simple JSON manipulation without external libraries 
// by passing/returning stringified JSON to leverage NodeJS fast V8 JSON engine.
// In a real high-perf app we might use nlohmann_json, but built-in strings is easier to deploy via node-gyp without pulling submodules.

using namespace Napi;

// =========================================================
// Read Cameras from DB file
// =========================================================
String ReadCamerasFile(const CallbackInfo& info) {
    Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        TypeError::New(env, "String expected").ThrowAsJavaScriptException();
        return String::New(env, "[]");
    }

    std::string dbPath = info[0].As<String>().Utf8Value();
    std::ifstream file(dbPath);
    if (!file.is_open()) {
        return String::New(env, "[]");
    }

    std::stringstream buffer;
    buffer << file.rdbuf();
    std::string content = buffer.str();
    if (content.empty()) content = "[]";

    return String::New(env, content);
}

// =========================================================
// Write Cameras to DB file
// =========================================================
Boolean WriteCamerasFile(const CallbackInfo& info) {
    Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        TypeError::New(env, "String and String expected").ThrowAsJavaScriptException();
        return Boolean::New(env, false);
    }

    std::string dbPath = info[0].As<String>().Utf8Value();
    std::string jsonContent = info[1].As<String>().Utf8Value();

    std::ofstream file(dbPath);
    if (!file.is_open()) {
        return Boolean::New(env, false);
    }

    file << jsonContent;
    file.close();
    return Boolean::New(env, true);
}

// =========================================================
// Sync Devices Logic
// To avoid strict JSON parsing in C++, we accept the current cameras JSON string
// and the incoming Sync JSON string, parse them in Node context, 
// update the logic in C++ via Napi::Array/Napi::Object, and return the modified Array.
// =========================================================
Value ProcessSyncLogic(const CallbackInfo& info) {
    Env env = info.Env();

    if (info.Length() < 3 || !info[0].IsArray() || !info[1].IsString() || !info[2].IsArray()) {
        TypeError::New(env, "Expected (camerasArray, gatewayIp, incomingDevicesArray)").ThrowAsJavaScriptException();
        return env.Null();
    }

    Array cameras = info[0].As<Array>();
    std::string gatewayIp = info[1].As<String>().Utf8Value();
    Array incomingDevices = info[2].As<Array>();

    bool dbChanged = false;

    // Loop qua danh sách thiết bị Gateway gửi lên và cập nhật vào VMS cameras
    for (uint32_t i = 0; i < incomingDevices.Length(); i++) {
        Object incDev = incomingDevices.Get(i).As<Object>();
        std::string incDeviceId = incDev.Has("deviceId") ? incDev.Get("deviceId").As<String>().Utf8Value() : "";
        std::string connectionStatus = incDev.Has("connectionStatus") ? incDev.Get("connectionStatus").As<String>().Utf8Value() : "ONLINE";

        // Tìm camera tương ứng trong VMS để cập nhật
        for (uint32_t j = 0; j < cameras.Length(); j++) {
            Object camera = cameras.Get(j).As<Object>();
            std::string camDeviceId = camera.Has("deviceId") ? camera.Get("deviceId").As<String>().Utf8Value() : "";

            if (camDeviceId == incDeviceId) {
                dbChanged = true;
                
                // Nếu là tín hiệu OFFLINE
                if (connectionStatus == "OFFLINE") {
                    camera.Set("gatewayId", env.Null());
                    camera.Set("connectionStatus", "OFFLINE");
                    camera.Set("userId", env.Null());
                    camera.Set("fullname", env.Null());
                } else {
                    // Cập nhật trạng thái ONLINE và các dữ liệu đi kèm
                    camera.Set("gatewayId", gatewayIp);
                    camera.Set("connectionStatus", connectionStatus);
                    if (incDev.Has("userId")) camera.Set("userId", incDev.Get("userId"));
                    if (incDev.Has("fullname")) camera.Set("fullname", incDev.Get("fullname"));
                    
                    // Telemetry Data Merge
                    if (incDev.Has("battery")) camera.Set("battery", incDev.Get("battery"));
                    if (incDev.Has("longitude")) camera.Set("longitude", incDev.Get("longitude"));
                    if (incDev.Has("latitude")) camera.Set("latitude", incDev.Get("latitude"));
                    if (incDev.Has("wifiState")) camera.Set("wifiState", incDev.Get("wifiState"));
                    if (incDev.Has("simState")) camera.Set("simState", incDev.Get("simState"));
                    if (incDev.Has("bluetoothState")) camera.Set("bluetoothState", incDev.Get("bluetoothState"));
                    if (incDev.Has("tfState")) camera.Set("tfState", incDev.Get("tfState"));
                    if (incDev.Has("tfCapacity")) camera.Set("tfCapacity", incDev.Get("tfCapacity"));
                    if (incDev.Has("workState")) camera.Set("workState", incDev.Get("workState"));
                    if (incDev.Has("workTime")) camera.Set("workTime", incDev.Get("workTime"));
                }
                break; // Xử lý xong camera này trong VMS
            }
        }
    }

    // Trường hợp đặc biệt: Nếu Gateway gửi danh sách trống (thường là khi khởi động)
    // thì ta sẽ offline toàn bộ camera đang thuộc về Gateway IP đó.
    if (incomingDevices.Length() == 0) {
        for (uint32_t j = 0; j < cameras.Length(); j++) {
            Object camera = cameras.Get(j).As<Object>();
            std::string currentGatewayId = "";
            if (camera.Has("gatewayId") && camera.Get("gatewayId").IsString()) {
                currentGatewayId = camera.Get("gatewayId").As<String>().Utf8Value();
            }

            if (currentGatewayId == gatewayIp) {
                camera.Set("gatewayId", env.Null());
                camera.Set("connectionStatus", "OFFLINE");
                camera.Set("userId", env.Null());
                camera.Set("fullname", env.Null());
                dbChanged = true;
            }
        }
    }

    Object result = Object::New(env);
    result.Set("changed", Boolean::New(env, dbChanged));
    result.Set("cameras", cameras);
    return result;
}


// Initialize module exports
Object Init(Env env, Object exports) {
    exports.Set(String::New(env, "readCamerasFile"), Function::New(env, ReadCamerasFile));
    exports.Set(String::New(env, "writeCamerasFile"), Function::New(env, WriteCamerasFile));
    exports.Set(String::New(env, "processSyncLogic"), Function::New(env, ProcessSyncLogic));
    return exports;
}

NODE_API_MODULE(vms_core, Init)
