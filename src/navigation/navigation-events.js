import { reroute } from "./reroute.js";
import { find } from "../utils/find.js";
import { formatErrorMessage } from "../applications/app-errors.js";
import { isInBrowser } from "../utils/runtime-environment.js";

/* We capture navigation event listeners so that we can make sure
 * that application navigation listeners are not called until
 * single-spa has ensured that the correct applications are
 * unmounted and mounted.
 */
const capturedEventListeners = {
  hashchange: [],
  popstate: [],
};

export const routingEventsListeningTo = ["hashchange", "popstate"];

export function navigateToUrl(obj) {
  let url;
  if (typeof obj === "string") {
    url = obj;
  } else if (this && this.href) {
    url = this.href;
  } else if (
    obj &&
    obj.currentTarget &&
    obj.currentTarget.href &&
    obj.preventDefault
  ) {
    url = obj.currentTarget.href;
    obj.preventDefault();
  } else {
    throw Error(
      formatErrorMessage(
        14,
        __DEV__ &&
          `singleSpaNavigate/navigateToUrl must be either called with a string url, with an <a> tag as its context, or with an event whose currentTarget is an <a> tag`
      )
    );
  }

  const current = parseUri(window.location.href);
  const destination = parseUri(url);

  if (url.indexOf("#") === 0) {
    window.location.hash = destination.hash;
  } else if (current.host !== destination.host && destination.host) {
    if (process.env.BABEL_ENV === "test") {
      return { wouldHaveReloadedThePage: true };
    } else {
      window.location.href = url;
    }
  } else if (
    destination.pathname === current.pathname &&
    destination.search === current.search
  ) {
    window.location.hash = destination.hash;
  } else {
    // different path, host, or query params
    window.history.pushState(null, null, url);
  }
}

/**
 * 调用捕获的事件监听器。
 * 该函数用于遍历并调用捕获的事件监听器数组中与特定事件类型匹配的监听器函数。
 * 它确保在 single-spa 完成应用程序的挂载/卸载后，才调用这些监听器函数。
 * 
 * @param {Array} eventArguments - 事件参数数组，通常包含事件对象。
 */
export function callCapturedEventListeners(eventArguments) {
  // 检查 eventArguments 是否存在
  if (eventArguments) {
    // 获取事件类型
    const eventType = eventArguments[0].type;
    // 检查事件类型是否在监听列表中
    if (routingEventsListeningTo.indexOf(eventType) >= 0) {
      // 遍历捕获的事件监听器数组
      capturedEventListeners[eventType].forEach((listener) => {
        try {
          // 调用监听器函数，并传递事件参数
          // The error thrown by application event listener should not break single-spa down.
          // Just like https://github.com/single-spa/single-spa/blob/85f5042dff960e40936f3a5069d56fc9477fac04/src/navigation/reroute.js#L140-L146 did
          listener.apply(this, eventArguments);
        } catch (e) {
          // 捕获并延迟抛出监听器函数中的错误，以避免中断 single-spa 的执行
          setTimeout(() => {
            throw e;
          });
        }
      });
    }
  }
}

let urlRerouteOnly;

function urlReroute() {
  reroute([], arguments);
}

function patchedUpdateState(updateState, methodName) {
  return function () {
    const urlBefore = window.location.href;
    const result = updateState.apply(this, arguments);
    const urlAfter = window.location.href;

    if (!urlRerouteOnly || urlBefore !== urlAfter) {
      // fire an artificial popstate event so that
      // single-spa applications know about routing that
      // occurs in a different application
      window.dispatchEvent(
        createPopStateEvent(window.history.state, methodName)
      );
    }

    return result;
  };
}

function createPopStateEvent(state, originalMethodName) {
  // https://github.com/single-spa/single-spa/issues/224 and https://github.com/single-spa/single-spa-angular/issues/49
  // We need a popstate event even though the browser doesn't do one by default when you call replaceState, so that
  // all the applications can reroute. We explicitly identify this extraneous event by setting singleSpa=true and
  // singleSpaTrigger=<pushState|replaceState> on the event instance.
  let evt;
  try {
    evt = new PopStateEvent("popstate", { state });
  } catch (err) {
    // IE 11 compatibility https://github.com/single-spa/single-spa/issues/299
    // https://docs.microsoft.com/en-us/openspecs/ie_standards/ms-html5e/bd560f47-b349-4d2c-baa8-f1560fb489dd
    evt = document.createEvent("PopStateEvent");
    evt.initPopStateEvent("popstate", false, false, state);
  }
  evt.singleSpa = true;
  evt.singleSpaTrigger = originalMethodName;
  return evt;
}

/**
 * 原始的 replaceState 方法
 */
export let originalReplaceState = null;

/**
 * 是否修补了历史 API 标志
 */ 
let historyApiIsPatched = false;


/**
 * 我们修补了历史 API，以便 single-spa 能够收到所有对 pushState/replaceState 的调用通知。
 * 我们修补了 addEventListener/removeEventListener，以便捕获所有 popstate/hashchange 事件监听器， 
 * 并延迟调用它们，直到 single-spa 完成应用程序的挂载/卸载。
 * @param {*} opts 
 */
export function patchHistoryApi(opts) {
  // 检查 historyApiIsPatched 变量，如果已经修补过历史 API，则抛出错误，防止重复修补
  if (historyApiIsPatched) {
    throw Error(
      formatErrorMessage(
        43,
        __DEV__ &&
          `single-spa: patchHistoryApi() was called after the history api was already patched.`
      )
    );
  }

  /**
   * 根据传入的 opts 参数设置 urlRerouteOnly 选项，如果没有传入或 opts 中没有 urlRerouteOnly 属性，则默认为 true
   */
  urlRerouteOnly =
    opts && opts.hasOwnProperty("urlRerouteOnly") ? opts.urlRerouteOnly : true;

  historyApiIsPatched = true;
  
  // 保存原始的 window.history.replaceState 方法，以便后续调用
  originalReplaceState = window.history.replaceState;

  // 添加 hashchange 和 popstate 事件监听器，当这些事件触发时，调用 urlReroute 函数
  window.addEventListener("hashchange", urlReroute);
  window.addEventListener("popstate", urlReroute);

  // Monkeypatch addEventListener so that we can ensure correct timing
  // 修补 window.addEventListener 和 window.removeEventListener 方法，以便捕获所有 popstate/hashchange 事件监听器，并延迟调用它们。
  const originalAddEventListener = window.addEventListener;
  const originalRemoveEventListener = window.removeEventListener;
  window.addEventListener = function (eventName, fn) {
    if (typeof fn === "function") {
      if (
        routingEventsListeningTo.indexOf(eventName) >= 0 &&
        !find(capturedEventListeners[eventName], (listener) => listener === fn)
      ) {
        capturedEventListeners[eventName].push(fn);
        return;
      }
    }

    return originalAddEventListener.apply(this, arguments);
  };

  window.removeEventListener = function (eventName, listenerFn) {
    if (typeof listenerFn === "function") {
      if (routingEventsListeningTo.indexOf(eventName) >= 0) {
        capturedEventListeners[eventName] = capturedEventListeners[
          eventName
        ].filter((fn) => fn !== listenerFn);
      }
    }

    return originalRemoveEventListener.apply(this, arguments);
  };

  // 修补 window.history.pushState 和 window.history.replaceState 方法，以便 single-spa 能够收到所有对 pushState/replaceState 的调用通知。
  window.history.pushState = patchedUpdateState(
    window.history.pushState,
    "pushState"
  );
  window.history.replaceState = patchedUpdateState(
    originalReplaceState,
    "replaceState"
  );
}

// Detect if single-spa has already been loaded on the page.
// If so, warn because this can result in lots of problems, including
// lots of extraneous popstate events and unexpected results for
// apis like getAppNames().
if (isInBrowser) {
  if (window.singleSpaNavigate) {
    console.warn(
      formatErrorMessage(
        41,
        __DEV__ &&
          "single-spa has been loaded twice on the page. This can result in unexpected behavior."
      )
    );
  } else {
    /* For convenience in `onclick` attributes, we expose a global function for navigating to
     * whatever an <a> tag's href is.
     */
    window.singleSpaNavigate = navigateToUrl;
  }
}

function parseUri(str) {
  const anchor = document.createElement("a");
  anchor.href = str;
  return anchor;
}
