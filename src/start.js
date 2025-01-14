import { reroute } from "./navigation/reroute.js";
import { patchHistoryApi } from "./navigation/navigation-events.js";
import { isInBrowser } from "./utils/runtime-environment.js";

// 是否开始的标识
let started = false;

/**
 * 启动应用的函数。
 * 
 * @param {Object} opts - 可选的配置对象，用于传递给 patchHistoryApi 函数。
 * 
 * @description
 * 该函数用于启动应用。它设置一个标志 `started` 为 `true`，表示应用已经启动。
 * 如果当前环境是浏览器，则调用 `patchHistoryApi` 函数来修补浏览器的历史 API，
 * 并调用 `reroute` 函数来重新路由应用。
 */
export function start(opts) {
  // 将 started 标志设置为 true，表示应用已经启动
  started = true;

  // 检查当前环境是否为浏览器
  if (isInBrowser) {
    // 如果是浏览器环境，调用 patchHistoryApi 函数来修补历史 API
    patchHistoryApi(opts);

    // 调用 reroute 函数来重新路由应用
    reroute();
  }
}

/**
 * 检查应用是否已经启动。
 * 
 * @returns {boolean} 如果应用已经启动，则返回 true；否则返回 false。
 */
export function isStarted() {
  // 返回 started 变量的值，该变量用于标识应用是否已经启动。
  return started;
}

