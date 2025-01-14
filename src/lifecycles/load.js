import {
  LOAD_ERROR,
  NOT_BOOTSTRAPPED,
  LOADING_SOURCE_CODE,
  SKIP_BECAUSE_BROKEN,
  NOT_LOADED,
  objectType,
  toName,
} from "../applications/app.helpers.js";
import { ensureValidAppTimeouts } from "../applications/timeouts.js";
import {
  handleAppError,
  formatErrorMessage,
} from "../applications/app-errors.js";
import {
  flattenFnArray,
  smellsLikeAPromise,
  validLifecycleFn,
} from "./lifecycle.helpers.js";
import { getProps } from "./prop.helpers.js";
import { assign } from "../utils/assign.js";
import { addProfileEntry } from "../devtools/profiler.js";

/**
 * 将应用程序或包裹加载为一个Promise。
 * 如果应用程序或包裹已经有一个加载Promise，则返回该Promise。
 * 如果应用程序或包裹的状态不是“未加载”或“加载错误”，则返回应用程序或包裹本身。
 * 否则，它将尝试加载应用程序或包裹，并处理任何加载错误。
 * 
 * @param {Object} appOrParcel - 要加载的应用程序或包裹。
 * @returns {Promise} 一个解析为加载的应用程序或包裹的Promise。
 */
export function toLoadPromise(appOrParcel) {
  // 返回一个立即解析的Promise，然后执行以下操作
  return Promise.resolve().then(() => {
    // 如果appOrParcel已经有一个loadPromise，直接返回它
    if (appOrParcel.loadPromise) {
      return appOrParcel.loadPromise;
    }

    // 如果appOrParcel的状态既不是NOT_LOADED也不是LOAD_ERROR，直接返回appOrParcel
    if (
      appOrParcel.status !== NOT_LOADED &&
      appOrParcel.status !== LOAD_ERROR
    ) {
      return appOrParcel;
    }

    // 用于性能分析的开始时间
    // let startTime;

    // 如果处于开发环境且开启了性能分析
    // if (__PROFILE__) {
    //   startTime = performance.now();
    // }

    // 将appOrParcel的状态设置为LOADING_SOURCE_CODE，表示正在加载源代码
    appOrParcel.status = LOADING_SOURCE_CODE;

    // 用于存储加载的应用程序选项和是否是用户错误
    let appOpts, isUserErr;

    // 返回一个Promise，用于加载应用程序
    return (appOrParcel.loadPromise = Promise.resolve()
      .then(() => {
        // 调用appOrParcel的loadApp方法，传入应用程序的属性，获取加载Promise
        const loadPromise = appOrParcel.loadApp(getProps(appOrParcel));
        // 如果loadPromise不像是一个Promise
        if (!smellsLikeAPromise(loadPromise)) {
          // 设置为用户错误
          isUserErr = true;
          // 抛出一个错误，提示加载函数没有返回一个Promise
          throw Error(
            formatErrorMessage(
              33,
              __DEV__ &&
                `single-spa loading function did not return a promise. Check the second argument to registerApplication('${toName(
                  appOrParcel
                )}', loadingFunction, activityFunction)`,
              toName(appOrParcel)
            )
          );
        }
        // 返回加载Promise的解析结果
        return loadPromise.then((val) => {
          // 重置加载错误时间
          appOrParcel.loadErrorTime = null;

          // 存储加载的应用程序选项
          appOpts = val;

          // 用于存储验证错误消息和代码
          let validationErrMessage, validationErrCode;

          // 如果加载的应用程序选项不是一个对象
          if (typeof appOpts !== "object") {
            validationErrCode = 34;
            // if (__DEV__) {
            //   validationErrMessage = `does not export anything`;
            // }
          }

          // 如果加载的应用程序选项没有有效的bootstrap函数
          if (
            // ES Modules don't have the Object prototype
            Object.prototype.hasOwnProperty.call(appOpts, "bootstrap") &&
            !validLifecycleFn(appOpts.bootstrap)
          ) {
            validationErrCode = 35;
            // if (__DEV__) {
            //   validationErrMessage = `does not export a valid bootstrap function or array of functions`;
            // }
          }

          // 如果加载的应用程序选项没有有效的mount函数
          if (!validLifecycleFn(appOpts.mount)) {
            validationErrCode = 36;
            // if (__DEV__) {
            //   validationErrMessage = `does not export a mount function or array of functions`;
            // }
          }

          // 如果加载的应用程序选项没有有效的unmount函数
          if (!validLifecycleFn(appOpts.unmount)) {
            validationErrCode = 37;
            // if (__DEV__) {
            //   validationErrMessage = `does not export a unmount function or array of functions`;
            // }
          }

          // 获取加载的应用程序选项的类型
          const type = objectType(appOpts);

          // 如果有验证错误代码
          if (validationErrCode) {
            // 用于存储应用程序选项的字符串表示
            let appOptsStr;
            try {
              // 将应用程序选项转换为字符串
              appOptsStr = JSON.stringify(appOpts);
            } catch {}
            // 打印错误消息
            console.error(
              formatErrorMessage(
                validationErrCode,
                __DEV__ &&
                  `The loading function for single-spa ${type} '${toName(
                    appOrParcel
                  )}' resolved with the following, which does not have bootstrap, mount, and unmount functions`,
                type,
                toName(appOrParcel),
                appOptsStr
              ),
              appOpts
            );
            // 处理应用程序错误
            handleAppError(
              validationErrMessage,
              appOrParcel,
              SKIP_BECAUSE_BROKEN
            );
            // 返回应用程序或包裹
            return appOrParcel;
          }

          // 如果加载的应用程序选项有devtools.overlays属性
          if (appOpts.devtools && appOpts.devtools.overlays) {
            // 合并devtools.overlays属性
            appOrParcel.devtools.overlays = assign(
              {},
              appOrParcel.devtools.overlays,
              appOpts.devtools.overlays
            );
          }

          // 将应用程序或包裹的状态设置为NOT_BOOTSTRAPPED
          appOrParcel.status = NOT_BOOTSTRAPPED;
          // 扁平化bootstrap函数
          appOrParcel.bootstrap = flattenFnArray(appOpts, "bootstrap");
          // 扁平化mount函数
          appOrParcel.mount = flattenFnArray(appOpts, "mount");
          // 扁平化unmount函数
          appOrParcel.unmount = flattenFnArray(appOpts, "unmount");
          // 扁平化unload函数
          appOrParcel.unload = flattenFnArray(appOpts, "unload");
          // 确保应用程序的超时设置有效
          appOrParcel.timeouts = ensureValidAppTimeouts(appOpts.timeouts);

          // 删除加载Promise
          delete appOrParcel.loadPromise;

          // 如果处于开发环境且开启了性能分析
          // if (__PROFILE__) {
          //   // 添加性能分析条目
          //   addProfileEntry(
          //     "application",
          //     toName(appOrParcel),
          //     "load",
          //     startTime,
          //     performance.now(),
          //     true
          //   );
          // }

          // 返回应用程序或包裹
          return appOrParcel;
        });
      })
      // 捕获加载过程中的错误
      .catch((err) => {
        // 删除加载Promise
        delete appOrParcel.loadPromise;

        // 用于存储新的状态
        let newStatus;
        // 如果是用户错误
        if (isUserErr) {
          newStatus = SKIP_BECAUSE_BROKEN;
        } else {
          // 设置为加载错误状态
          newStatus = LOAD_ERROR;
          // 设置加载错误时间
          appOrParcel.loadErrorTime = new Date().getTime();
        }
        // 处理应用程序错误
        handleAppError(err, appOrParcel, newStatus);

        // 如果处于开发环境且开启了性能分析
        // if (__PROFILE__) {
        //   // 添加性能分析条目
        //   addProfileEntry(
        //     "application",
        //     toName(appOrParcel),
        //     "load",
        //     startTime,
        //     performance.now(),
        //     false
        //   );
        // }

        // 返回应用程序或包裹
        return appOrParcel;
      }));
  });
}
