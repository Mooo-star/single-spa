import CustomEvent from "custom-event";
import { isStarted } from "../start.js";
import { toLoadPromise } from "../lifecycles/load.js";
import { toBootstrapPromise } from "../lifecycles/bootstrap.js";
import { toMountPromise } from "../lifecycles/mount.js";
import { toUnmountPromise } from "../lifecycles/unmount.js";
import {
  getAppStatus,
  getAppChanges,
  getMountedApps,
} from "../applications/apps.js";
import {
  callCapturedEventListeners,
  originalReplaceState,
} from "./navigation-events.js";
import { toUnloadPromise } from "../lifecycles/unload.js";
import {
  toName,
  shouldBeActive,
  NOT_MOUNTED,
  MOUNTED,
  NOT_LOADED,
  SKIP_BECAUSE_BROKEN,
} from "../applications/app.helpers.js";
import { assign } from "../utils/assign.js";
import { isInBrowser } from "../utils/runtime-environment.js";
import { formatErrorMessage } from "../applications/app-errors.js";
import { addProfileEntry } from "../devtools/profiler.js";

let appChangeUnderway = false,
  peopleWaitingOnAppChange = [],
  currentUrl = isInBrowser && window.location.href;

export function triggerAppChange() {
  // Call reroute with no arguments, intentionally
  return reroute();
}

export function reroute(
  pendingPromises = [],
  eventArguments,
  silentNavigation = false
) {
  // 如果正在进行应用程序更改，则返回一个新的 Promise，将其 resolve 和 reject 函数添加到 peopleWaitingOnAppChange 数组中
  if (appChangeUnderway) {
    return new Promise((resolve, reject) => {
      peopleWaitingOnAppChange.push({
        resolve,
        reject,
        eventArguments,
      });
    });
  }

  let startTime, profilerKind;

  // 如果启用了性能分析，则记录开始时间并根据 silentNavigation 和 eventArguments 设置 profilerKind
  // if (__PROFILE__) {
  //   startTime = performance.now();
  //   if (silentNavigation) {
  //     profilerKind = "silentNavigation";
  //   } else if (eventArguments) {
  //     profilerKind = "browserNavigation";
  //   } else {
  //     profilerKind = "triggerAppChange";
  //   }
  // }

  /**
   * 获取需要卸载、卸载、加载和挂载的应用程序
   * @param {*} appsToUnload - 这些是需要卸载的应用。通常，这些应用当前处于挂载状态（MOUNTED），由于路由变化，它们不再需要被显示，因此需要被卸载。
   * @param {*} appsToUnmount - 这些是需要卸载的应用。与 appsToUnload 不同的是，appsToUnmount 中的应用可能已经处于卸载过程中，或者它们可能由于某些原因（如错误）而无法完成卸载。
   * @param {*} appsToUnload - 这些是需要加载的应用。这些应用当前处于未加载状态（NOT_LOADED），由于路由变化，它们需要被加载并可能随后被挂载。
   * @param {*} appsToMount - 这些是需要挂载的应用。这些应用已经被加载（可能在之前的路由变化中加载），但由于路由变化，它们现在需要被挂载到 DOM 中。
   */
  const { appsToUnload, appsToUnmount, appsToLoad, appsToMount } =
    getAppChanges();
  let appsThatChanged,
    cancelPromises = [],
    oldUrl = currentUrl,
    newUrl = (currentUrl = window.location.href);

  // 如果 single-spa 已经启动，则执行应用程序更改
  if (isStarted()) {
    appChangeUnderway = true;
    appsThatChanged = appsToUnload.concat(
      appsToLoad,
      appsToUnmount,
      appsToMount
    );
    return performAppChanges();
  } else {
    // 如果 single-spa 尚未启动，则加载应用程序
    appsThatChanged = appsToLoad;
    return loadApps();
  }

  // -------------------------- 下面的都是辅助方法，一个一个的点进去看在干什么吧 ----------------------------------------

  /**
   * 添加一个取消导航的 Promise 到 cancelPromises 数组中
   * @param {*} val - 可以是一个值或一个 Promise
   */
  function cancelNavigation(val = true) {
    const promise =
      typeof val?.then === "function" ? val : Promise.resolve(val);
    cancelPromises.push(
      promise.catch((err) => {
        console.warn(
          Error(
            formatErrorMessage(
              42,
              __DEV__ &&
                `single-spa: A cancelNavigation promise rejected with the following value: ${err}`
            )
          )
        );
        console.warn(err);

        // 将 Promise 拒绝解释为导航不应取消
        return false;
      })
    );
  }

  /**
   * 加载应用程序
   * @returns {Promise} 加载应用程序的 Promise
   */
  function loadApps() {
    return Promise.resolve().then(() => {
      const loadPromises = appsToLoad.map(toLoadPromise);
      // let succeeded;

      return (
        Promise.all(loadPromises)
          .then(callAllEventListeners)
          // 在调用 start() 之前没有挂载的应用程序，因此我们总是返回 []
          .then(() => {
            // if (__PROFILE__) {
            //   succeeded = true;
            // }

            return [];
          })
          .catch((err) => {
            // if (__PROFILE__) {
            //   succeeded = false;
            // }

            callAllEventListeners();
            throw err;
          })
          .finally(() => {
            // if (__PROFILE__) {
            //   addProfileEntry(
            //     "routing",
            //     "loadApps",
            //     profilerKind,
            //     startTime,
            //     performance.now(),
            //     succeeded
            //   );
            // }
          })
      );
    });
  }

  /**
   * 执行应用程序更改
   * @returns {Promise} 执行应用程序更改的 Promise
   */
  function performAppChanges() {
    // 使用 Promise.resolve().then() 来确保异步操作按顺序执行
    return Promise.resolve().then(() => {
      // 触发 before-no-app-change 或 before-app-change 事件
      fireSingleSpaEvent(
        appsThatChanged.length === 0
          ? "before-no-app-change"
          : "before-app-change",
        getCustomEventDetail(true)
      );

      // 触发 before-routing-event 事件
      fireSingleSpaEvent(
        "before-routing-event",
        getCustomEventDetail(true, { cancelNavigation })
      );

      // 等待所有取消导航的 Promise 完成
      return Promise.all(cancelPromises).then((cancelValues) => {
        // 检查是否有任何导航被取消
        const navigationIsCanceled = cancelValues.some((v) => v);

        if (navigationIsCanceled) {
          // 将 URL 更改回旧 URL，不触发正常的 single-spa 重路由
          originalReplaceState.call(
            window.history,
            history.state,
            "",
            oldUrl.substring(location.origin.length)
          );

          // single-spa 内部对当前 URL 的跟踪需要在上述 URL 更改后更新
          currentUrl = location.href;

          // 必要的，以便 reroute 函数知道当前的 reroute 已完成
          appChangeUnderway = false;

          if (__PROFILE__) {
            addProfileEntry(
              "routing",
              "navigationCanceled",
              profilerKind,
              startTime,
              performance.now(),
              true
            );
          }

          // 告诉 single-spa 再次重路由，这次将 URL 设置为旧 URL
          return reroute(pendingPromises, eventArguments, true);
        }

        // 创建卸载和卸载应用程序的 Promise 数组
        const unloadPromises = appsToUnload.map(toUnloadPromise);

        // 创建卸载和卸载应用程序的 Promise 数组
        const unmountUnloadPromises = appsToUnmount
          .map(toUnmountPromise)
          .map((unmountPromise) => unmountPromise.then(toUnloadPromise));

        // 合并卸载和卸载应用程序的 Promise 数组
        const allUnmountPromises = unmountUnloadPromises.concat(unloadPromises);

        // 创建一个 Promise，等待所有应用程序卸载完成
        const unmountAllPromise = Promise.all(allUnmountPromises);

        let unmountFinishedTime;

        // 当所有应用程序卸载完成时，触发 before-mount-routing-event 事件
        unmountAllPromise.then(
          () => {
            if (__PROFILE__) {
              unmountFinishedTime = performance.now();

              addProfileEntry(
                "routing",
                "unmountAndUnload",
                profilerKind,
                startTime,
                performance.now(),
                true
              );
            }
            fireSingleSpaEvent(
              "before-mount-routing-event",
              getCustomEventDetail(true)
            );
          },
          (err) => {
            if (__PROFILE__) {
              addProfileEntry(
                "routing",
                "unmountAndUnload",
                profilerKind,
                startTime,
                performance.now(),
                true
              );
            }

            throw err;
          }
        );

        /* 我们在其他应用程序卸载时加载和引导应用程序，但我们
         * 等到所有应用程序卸载完成后再挂载应用程序
         */
        const loadThenMountPromises = appsToLoad.map((app) => {
          return toLoadPromise(app).then((app) =>
            tryToBootstrapAndMount(app, unmountAllPromise)
          );
        });

        /* 这些是已经引导并只需要
         * 挂载的应用程序。它们都等待所有卸载的应用程序完成后再挂载。
         */
        const mountPromises = appsToMount
          .filter((appToMount) => appsToLoad.indexOf(appToMount) < 0)
          .map((appToMount) => {
            return tryToBootstrapAndMount(appToMount, unmountAllPromise);
          });
        return unmountAllPromise
          .catch((err) => {
            callAllEventListeners();
            throw err;
          })
          .then(() => {
            /* 现在需要卸载的应用程序已经卸载，它们的 DOM 导航
             * 事件（如 hashchange 或 popstate）应该已经清理。所以现在可以
             * 让剩余的捕获事件监听器处理 DOM 事件。
             */
            callAllEventListeners();

            return Promise.all(loadThenMountPromises.concat(mountPromises))
              .catch((err) => {
                pendingPromises.forEach((promise) => promise.reject(err));
                throw err;
              })
              .then(finishUpAndReturn)
              .then(
                () => {
                  if (__PROFILE__) {
                    addProfileEntry(
                      "routing",
                      "loadAndMount",
                      profilerKind,
                      unmountFinishedTime,
                      performance.now(),
                      true
                    );
                  }
                },
                (err) => {
                  if (__PROFILE__) {
                    addProfileEntry(
                      "routing",
                      "loadAndMount",
                      profilerKind,
                      unmountFinishedTime,
                      performance.now(),
                      false
                    );
                  }

                  throw err;
                }
              );
          });
      });
    });
  }

  function finishUpAndReturn() {
    const returnValue = getMountedApps();
    pendingPromises.forEach((promise) => promise.resolve(returnValue));

    try {
      const appChangeEventName =
        appsThatChanged.length === 0 ? "no-app-change" : "app-change";
      fireSingleSpaEvent(appChangeEventName, getCustomEventDetail());
      fireSingleSpaEvent("routing-event", getCustomEventDetail());
    } catch (err) {
      /* We use a setTimeout because if someone else's event handler throws an error, single-spa
       * needs to carry on. If a listener to the event throws an error, it's their own fault, not
       * single-spa's.
       */
      setTimeout(() => {
        throw err;
      });
    }

    /* Setting this allows for subsequent calls to reroute() to actually perform
     * a reroute instead of just getting queued behind the current reroute call.
     * We want to do this after the mounting/unmounting is done but before we
     * resolve the promise for the `reroute` function.
     */
    appChangeUnderway = false;

    if (peopleWaitingOnAppChange.length > 0) {
      /* While we were rerouting, someone else triggered another reroute that got queued.
       * So we need reroute again.
       */
      const nextPendingPromises = peopleWaitingOnAppChange;
      peopleWaitingOnAppChange = [];
      reroute(nextPendingPromises);
    }

    return returnValue;
  }

  /* We need to call all event listeners that have been delayed because they were
   * waiting on single-spa. This includes haschange and popstate events for both
   * the current run of performAppChanges(), but also all of the queued event listeners.
   * We want to call the listeners in the same order as if they had not been delayed by
   * single-spa, which means queued ones first and then the most recent one.
   */
  /**
   * 调用所有被捕获的事件监听器
   * 这个函数用于在导航过程中调用所有被捕获的事件监听器。
   * 在静默导航期间（即导航被取消并返回旧URL时），不会触发任何popstate或hashchange事件。
   * 否则，它会遍历所有挂起的Promise，并调用每个Promise的事件参数对应的事件监听器。
   * 最后，它还会调用当前事件参数对应的事件监听器。
   */
  function callAllEventListeners() {
    // During silent navigation (when navigation was canceled and we're going back to the old URL),
    // we should not fire any popstate / hashchange events
    if (!silentNavigation) {
      // 遍历所有挂起的Promise
      pendingPromises.forEach((pendingPromise) => {
        // 调用每个Promise的事件参数对应的事件监听器
        callCapturedEventListeners(pendingPromise.eventArguments);
      });

      // 调用当前事件参数对应的事件监听器
      callCapturedEventListeners(eventArguments);
    }
  }

  function getCustomEventDetail(isBeforeChanges = false, extraProperties) {
    const newAppStatuses = {};
    const appsByNewStatus = {
      // for apps that were mounted
      [MOUNTED]: [],
      // for apps that were unmounted
      [NOT_MOUNTED]: [],
      // apps that were forcibly unloaded
      [NOT_LOADED]: [],
      // apps that attempted to do something but are broken now
      [SKIP_BECAUSE_BROKEN]: [],
    };

    if (isBeforeChanges) {
      appsToLoad.concat(appsToMount).forEach((app, index) => {
        addApp(app, MOUNTED);
      });
      appsToUnload.forEach((app) => {
        addApp(app, NOT_LOADED);
      });
      appsToUnmount.forEach((app) => {
        addApp(app, NOT_MOUNTED);
      });
    } else {
      appsThatChanged.forEach((app) => {
        addApp(app);
      });
    }

    const result = {
      detail: {
        newAppStatuses,
        appsByNewStatus,
        totalAppChanges: appsThatChanged.length,
        originalEvent: eventArguments?.[0],
        oldUrl,
        newUrl,
      },
    };

    if (extraProperties) {
      assign(result.detail, extraProperties);
    }

    return result;

    function addApp(app, status) {
      const appName = toName(app);
      status = status || getAppStatus(appName);
      newAppStatuses[appName] = status;
      const statusArr = (appsByNewStatus[status] =
        appsByNewStatus[status] || []);
      statusArr.push(appName);
    }
  }

  function fireSingleSpaEvent(name, eventProperties) {
    // During silent navigation (caused by navigation cancelation), we should not
    // fire any single-spa events
    if (!silentNavigation) {
      window.dispatchEvent(
        new CustomEvent(`single-spa:${name}`, eventProperties)
      );
    }
  }
}

/**
 * Let's imagine that some kind of delay occurred during application loading.
 * The user without waiting for the application to load switched to another route,
 * this means that we shouldn't bootstrap and mount that application, thus we check
 * twice if that application should be active before bootstrapping and mounting.
 * https://github.com/single-spa/single-spa/issues/524
 */
function tryToBootstrapAndMount(app, unmountAllPromise) {
  if (shouldBeActive(app)) {
    return toBootstrapPromise(app).then((app) =>
      unmountAllPromise.then(() =>
        shouldBeActive(app) ? toMountPromise(app) : app
      )
    );
  } else {
    return unmountAllPromise.then(() => app);
  }
}
