/**
 * Native Node.js addon to raise the file descriptor soft limit on macOS/Linux.
 *
 * macOS GUI apps (launched via Finder/dock) inherit a 256 FD soft limit from
 * launchd. This is far too low for Electron + Claude subprocesses + watchers.
 * The hard limit is typically 10240+ so we can raise the soft limit without
 * requiring root privileges.
 *
 * Build: node-gyp rebuild --target=<electron-version> --arch=<arch> \
 *        --dist-url=https://electronjs.org/headers
 *
 * Usage from Node.js:
 *   const addon = require('./build/Release/raise_fd_limit.node');
 *   const newLimit = addon.raise(10240); // returns actual new soft limit
 */

#include <node_api.h>
#include <sys/resource.h>
#include <errno.h>
#include <string.h>

static napi_value Raise(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  // Default target: 10240 (matches macOS hard limit default)
  uint64_t target = 10240;
  if (argc >= 1) {
    int64_t val;
    napi_get_value_int64(env, argv[0], &val);
    if (val > 0) target = (uint64_t)val;
  }

  struct rlimit rl;
  if (getrlimit(RLIMIT_NOFILE, &rl) != 0) {
    napi_throw_error(env, NULL, strerror(errno));
    return NULL;
  }

  // Don't lower the limit if it's already higher
  if (rl.rlim_cur >= target) {
    napi_value result;
    napi_create_int64(env, (int64_t)rl.rlim_cur, &result);
    return result;
  }

  // Clamp target to hard limit
  if (rl.rlim_max != RLIM_INFINITY && target > rl.rlim_max) {
    target = rl.rlim_max;
  }

  rl.rlim_cur = target;

  if (setrlimit(RLIMIT_NOFILE, &rl) != 0) {
    napi_throw_error(env, NULL, strerror(errno));
    return NULL;
  }

  napi_value result;
  napi_create_int64(env, (int64_t)rl.rlim_cur, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "raise", NAPI_AUTO_LENGTH, Raise, NULL, &fn);
  napi_set_named_property(env, exports, "raise", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
