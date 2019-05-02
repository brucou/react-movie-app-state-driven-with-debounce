import { INIT_EVENT, INIT_STATE, NO_OUTPUT, NO_STATE_UPDATE } from "state-transducer";
import {
  CANCEL_TIMER, COMMAND_MOVIE_DETAILS_SEARCH, COMMAND_MOVIE_SEARCH, COMMAND_RENDER, DISCOVERY_REQUEST, events,
  MOVIE_DETAIL_QUERYING, MOVIE_DETAIL_SELECTION, MOVIE_DETAIL_SELECTION_ERROR, MOVIE_QUERYING, MOVIE_SELECTION,
  MOVIE_SELECTION_ERROR, RESTART_TIMER, screens as screenIds, START, START_TIMER, TIMER_REGISTERING, TIMER_RUNNING
} from "./properties";
import { makeQuerySlug, runMovieDetailQuery, runMovieSearchQuery } from "./helpers";
import { applyPatch } from "json-patch-es6";

/**
 *
 * @param {ExtendedState} extendedState
 * @param {Operation[]} extendedStateUpdateOperations
 * @returns {ExtendedState}
 */
export function applyJSONpatch(extendedState, extendedStateUpdateOperations) {
  return applyPatch(
    extendedState,
    extendedStateUpdateOperations || [],
    false,
    false
  ).newDocument;
}

const NO_ACTIONS = () => ({ outputs: NO_OUTPUT, updates: NO_STATE_UPDATE });

const initialControlState = START;
const initialExtendedState = {
  queryFieldHasChanged: false,
  movieQuery: "",
  results: null,
  movieTitle: null,
  movieDetails: null,
  cast: null,
  timerId: null
};
const states = {
  [START]: "",
  [MOVIE_QUERYING]: "",
  [MOVIE_SELECTION]: "",
  [MOVIE_SELECTION_ERROR]: "",
  [MOVIE_DETAIL_QUERYING]: "",
  [MOVIE_DETAIL_SELECTION]: "",
  [MOVIE_DETAIL_SELECTION_ERROR]: "",
  [TIMER_RUNNING]: "",
  [TIMER_REGISTERING]: ""
};
const {
  SEARCH_ERROR_MOVIE_RECEIVED,
  USER_NAVIGATED_TO_APP,
  QUERY_CHANGED,
  MOVIE_DETAILS_DESELECTED,
  MOVIE_SELECTED,
  SEARCH_ERROR_RECEIVED,
  SEARCH_RESULTS_MOVIE_RECEIVED,
  SEARCH_RESULTS_RECEIVED,
  TIMER_EXPIRED,
  TIMER_ID_RECEIVED
} = events;
const {
  LOADING_SCREEN,
  SEARCH_ERROR_SCREEN,
  SEARCH_RESULTS_AND_LOADING_SCREEN,
  SEARCH_RESULTS_SCREEN,
  SEARCH_RESULTS_WITH_MOVIE_DETAILS,
  SEARCH_RESULTS_WITH_MOVIE_DETAILS_AND_LOADING_SCREEN,
  SEARCH_RESULTS_WITH_MOVIE_DETAILS_ERROR
} = screenIds;
const transitions = [
  { from: INIT_STATE, event: INIT_EVENT, to: START, action: NO_ACTIONS },
  {
    from: START,
    event: USER_NAVIGATED_TO_APP,
    to: MOVIE_QUERYING,
    action: displayLoadingScreenAndQueryDb
  },
  {
    from: MOVIE_QUERYING,
    event: SEARCH_RESULTS_RECEIVED,
    to: MOVIE_SELECTION,
    action: displayMovieSearchResultsScreen
  },
  {
    from: MOVIE_QUERYING,
    event: QUERY_CHANGED,
    to: TIMER_RUNNING,
    action: displayLoadingScreenAndStartTimer
  },
  {
    from: TIMER_RUNNING,
    event: QUERY_CHANGED,
    to: TIMER_RUNNING,
    action: displayLoadingScreenAndRestartTimer
  },
  {
    from: TIMER_RUNNING,
    event: TIMER_EXPIRED,
    to: MOVIE_QUERYING,
    action: displayLoadingScreenAndQueryDbAndCancelTimer
  },
  {
    from: TIMER_RUNNING,
    event: TIMER_ID_RECEIVED,
    to: TIMER_REGISTERING,
    action: registerTimerId
  },
  {
    from: TIMER_REGISTERING,
    // Eventless transition!
    event: void 0,
    to: TIMER_RUNNING,
    action: NO_ACTIONS
  },
  {
    from: MOVIE_SELECTION,
    event: QUERY_CHANGED,
    to: MOVIE_QUERYING,
    action: displayLoadingScreenAndQueryNonEmpty
  },
  {
    from: MOVIE_QUERYING,
    event: SEARCH_ERROR_RECEIVED,
    to: MOVIE_SELECTION_ERROR,
    action: displayMovieSearchErrorScreen
  },
  {
    from: MOVIE_SELECTION,
    event: MOVIE_SELECTED,
    to: MOVIE_DETAIL_QUERYING,
    action: displayDetailsLoadingScreenAndQueryDetailsDb
  },
  {
    from: MOVIE_DETAIL_QUERYING,
    event: SEARCH_RESULTS_MOVIE_RECEIVED,
    to: MOVIE_DETAIL_SELECTION,
    action: displayMovieDetailsSearchResultsScreen
  },
  {
    from: MOVIE_DETAIL_QUERYING,
    event: SEARCH_ERROR_MOVIE_RECEIVED,
    to: MOVIE_DETAIL_SELECTION_ERROR,
    action: displayMovieDetailsSearchErrorScreen
  },
  {
    from: MOVIE_DETAIL_SELECTION,
    event: MOVIE_DETAILS_DESELECTED,
    to: MOVIE_SELECTION,
    action: displayCurrentMovieSearchResultsScreen
  }
];
export const commandHandlers = {
  [COMMAND_MOVIE_SEARCH]: (next, _query, effectHandlers) => {
    const querySlug = _query === "" ? DISCOVERY_REQUEST : makeQuerySlug(_query);

    effectHandlers
      .runMovieSearchQuery(querySlug)
      .then(data => {
        next({
          [SEARCH_RESULTS_RECEIVED]: {
            results: data.results,
            query: _query
          }
        });
      })
      .catch(error => {
        next({ [SEARCH_ERROR_RECEIVED]: { query: _query } });
      });
  },
  [COMMAND_MOVIE_DETAILS_SEARCH]: (next, movieId, effectHandlers) => {
    effectHandlers
      .runMovieDetailQuery(movieId)
      .then(([details, cast]) =>
        next({ [SEARCH_RESULTS_MOVIE_RECEIVED]: [details, cast] })
      )
      .catch(err => next({ [SEARCH_ERROR_MOVIE_RECEIVED]: err }));
  },
  [START_TIMER]: (next, { duration }, effectHandlers) => {
    // Semantics are important here. The REGISTER_TIMER event MUST be received prior to the TIMER_EXPIRED event
    // This means that obviously it is not a good idea to have a timer of 0 - though it may still work
    // if `setTimeOut` schedules its callback as a macrotask, and `next` schedules listeners synchronously or as
    // microtasks Second, we want REGISTER_TIMER to be fast enough so no other events may be processed by the machine
    // in that time lest we may loose events like SEARCH_RESULTS_MOVIE_RECEIVED! Having a synchronous event emitter has
    // known drawbacks - some annoying edge cases in case of synchronous re-entry I thus recommend a contract forcing
    // event emitters into scheduling listeners on microtasks.
    const timerId = effectHandlers.startTimer(next, TIMER_EXPIRED, duration);
    next({ [TIMER_ID_RECEIVED]: timerId });
  },
  [RESTART_TIMER]: (next, { duration, timerId }, effectHandlers) => {
    effectHandlers.cancelTimer(timerId);
    const newTimerId = effectHandlers.startTimer(next, TIMER_EXPIRED, duration);
    next({ [TIMER_ID_RECEIVED]: newTimerId });
  },
  [CANCEL_TIMER]: (next, { timerId }, effectHandlers) => {
    effectHandlers.cancelTimer(timerId);
  }
};

export const effectHandlers = {
  runMovieSearchQuery: runMovieSearchQuery,
  runMovieDetailQuery: runMovieDetailQuery,
  startTimer: (next, TIMER_EXPIRED, duration) =>
    setTimeout(() => next({ [TIMER_EXPIRED]: void 0 }), duration),
  cancelTimer: timerId => window.clearTimeout(timerId)
};

function displayLoadingScreenAndQueryDb(extendedState, eventData, fsmSettings) {
  const searchCommand = {
    command: COMMAND_MOVIE_SEARCH,
    params: ""
  };
  const renderCommand = {
    command: COMMAND_RENDER,
    params: {
      screen: LOADING_SCREEN,
      postRenderCallback: () => {console.log(`rendered`, renderCommand.params)}
    }
  };
  return {
    updates: NO_STATE_UPDATE,
    outputs: [renderCommand, searchCommand]
  };
}

function displayLoadingScreenAndQueryDbAndCancelTimer(extendedState, eventData, fsmSettings) {
  const { movieQuery, results, timerId } = extendedState;
  const searchCommand = {
    command: COMMAND_MOVIE_SEARCH,
    params: movieQuery
  };
  const renderCommand = {
    command: COMMAND_RENDER,
    params: {
      screen: SEARCH_RESULTS_AND_LOADING_SCREEN,
      query: movieQuery,
      results,
      postRenderCallback: () => {console.log(`rendered`, renderCommand.params)}
    }
  };
  const cancelTimerCommand = {
    command: CANCEL_TIMER,
    params: { timerId }
  };
  return {
    updates: NO_STATE_UPDATE,
    outputs: [renderCommand, searchCommand, cancelTimerCommand]
  };
}

/**
 * @param {{debounceTimer: Number}} fsmSettings
 */
function displayLoadingScreenAndStartTimer(extendedState, eventData, fsmSettings) {
  const { results } = extendedState;
  const query = eventData;
  const renderCommand = {
    command: COMMAND_RENDER,
    params: {
      screen: SEARCH_RESULTS_AND_LOADING_SCREEN,
      results,
      query
    }
  };
  const startTimerCommand = {
    command: START_TIMER,
    params: {
      duration: fsmSettings.debounceTimer,
      postRenderCallback: () => {console.log(`rendered`, renderCommand.params)
      }
    }
  };
  return {
    updates: [
      { op: "add", path: "/queryFieldHasChanged", value: true },
      { op: "add", path: "/movieQuery", value: query }
    ],
    outputs: [renderCommand, startTimerCommand]
  };
}

/**
 * @param {{debounceTimer: Number}} fsmSettings
 */
function displayLoadingScreenAndRestartTimer(extendedState, eventData, fsmSettings) {
  const { timerId, results, movieQuery } = extendedState;
  const restartTimerCommand = {
    command: RESTART_TIMER,
    params: { duration: fsmSettings.debounceTimer, timerId }
  };
  const query = eventData;
  const renderCommand = {
    command: COMMAND_RENDER,
    params: {
      screen: SEARCH_RESULTS_AND_LOADING_SCREEN,
      results,
      query,
      postRenderCallback: () => {console.log(`rendered`, renderCommand.params)}
    }
  };
  return {
    updates: [
      { op: "add", path: "/queryFieldHasChanged", value: true },
      { op: "add", path: "/movieQuery", value: query }
    ],
    outputs: [renderCommand, restartTimerCommand]
  };
}

function displayLoadingScreenAndQueryNonEmpty(extendedState, eventData, fsmSettings) {
  const {
    queryFieldHasChanged,
    movieQuery,
    results,
    movieTitle
  } = extendedState;
  const query = eventData;
  const searchCommand = {
    command: COMMAND_MOVIE_SEARCH,
    params: query
  };
  const renderCommand = {
    command: COMMAND_RENDER,
    params: {
      screen: SEARCH_RESULTS_AND_LOADING_SCREEN,
      results,
      query,
      postRenderCallback: () => {console.log(`rendered`, renderCommand.params)}
    }
  };
  return {
    updates: [
      { op: "add", path: "/queryFieldHasChanged", value: true },
      { op: "add", path: "/movieQuery", value: query }
    ],
    outputs: [renderCommand, searchCommand]
  };
}

function displayMovieSearchResultsScreen(extendedState, eventData, fsmSettings) {
  const searchResults = eventData;
  const { results, query } = searchResults;
  const renderCommand = {
    command: COMMAND_RENDER,
    params: {
      screen: SEARCH_RESULTS_SCREEN,
      results,
      query: query || "",
      postRenderCallback: () => {console.log(`rendered`, renderCommand.params)}
    }
  };

  return {
    updates: [{ op: "add", path: "/results", value: results }],
    outputs: [renderCommand]
  };
}

function displayCurrentMovieSearchResultsScreen(extendedState, eventData, fsmSettings) {
  const { movieQuery, results } = extendedState;
  const renderCommand = {
    command: COMMAND_RENDER,
    params: {
      screen: SEARCH_RESULTS_SCREEN,
      results,
      query: movieQuery || "",
      postRenderCallback: () => {console.log(`rendered`, renderCommand.params)}
    }
  };

  return {
    updates: NO_STATE_UPDATE,
    outputs: [renderCommand]
  };
}

function displayMovieSearchErrorScreen(extendedState, eventData, fsmSettings) {
  const {
    queryFieldHasChanged,
    movieQuery,
    results,
    movieTitle
  } = extendedState;
  const renderCommand = {
    command: COMMAND_RENDER,
    params: {
      screen: SEARCH_ERROR_SCREEN,
      query: queryFieldHasChanged ? movieQuery : "",
      postRenderCallback: () => {console.log(`rendered`, renderCommand.params)}
    }
  };

  return {
    updates: NO_STATE_UPDATE,
    outputs: [renderCommand]
  };
}

function displayDetailsLoadingScreenAndQueryDetailsDb(extendedState, eventData, fsmSettings) {
  const { movie } = eventData;
  const movieId = movie.id;
  const { movieQuery, results } = extendedState;

  const searchCommand = {
    command: COMMAND_MOVIE_DETAILS_SEARCH,
    params: movieId
  };
  const renderCommand = {
    command: COMMAND_RENDER,
    params: {
      screen: SEARCH_RESULTS_WITH_MOVIE_DETAILS_AND_LOADING_SCREEN,
      results,
      query: movieQuery,
      title: movie.title,
      postRenderCallback: () => {console.log(`rendered`, renderCommand.params)}
    }
  };

  return {
    updates: [{ op: "add", path: "/movieTitle", value: movie.title }],
    outputs: [renderCommand, searchCommand]
  };
}

function displayMovieDetailsSearchResultsScreen(extendedState, eventData, fsmSettings) {
  const [movieDetails, cast] = eventData;
  const {
    queryFieldHasChanged,
    movieQuery,
    results,
    movieTitle
  } = extendedState;

  const renderCommand = {
    command: COMMAND_RENDER,
    params: {
      screen: SEARCH_RESULTS_WITH_MOVIE_DETAILS,
      results,
      query: movieQuery,
      title: movieTitle,
      details: movieDetails,
      cast,
      postRenderCallback: () => {console.log(`rendered`, renderCommand.params)}
    }
  };

  return {
    updates: [
      { op: "add", path: "/movieDetails", value: movieDetails },
      { op: "add", path: "/cast", value: cast }
    ],
    outputs: [renderCommand]
  };
}

function displayMovieDetailsSearchErrorScreen(extendedState, eventData, fsmSettings) {
  const {
    queryFieldHasChanged,
    movieQuery,
    results,
    movieTitle
  } = extendedState;

  const renderCommand = {
    command: COMMAND_RENDER,
    params: {
      screen: SEARCH_RESULTS_WITH_MOVIE_DETAILS_ERROR,
      results,
      query: movieQuery,
      title: movieTitle,
      postRenderCallback: () => {console.log(`rendered`, renderCommand.params)}
    }
  };

  return {
    updates: NO_STATE_UPDATE,
    outputs: [renderCommand]
  };
}

function registerTimerId(extendedState, eventData, fsmSettings) {
  const timerId = eventData;
  return {
    updates: [{ op: "add", path: "/timerId", value: timerId }],
    outputs: []
  };
}

// Guards
function isExpectedMovieResults(extendedState, eventData, settings) {
  const { query: fetched } = eventData;
  const { movieQuery: expected } = extendedState;
  return fetched === expected;
}

function isNotExpectedMovieResults(extendedState, eventData, settings) {
  return !isExpectedMovieResults(extendedState, eventData, settings);
}

const movieSearchFsmDef = {
  initialControlState,
  initialExtendedState,
  states,
  events: Object.values(events),
  transitions,
  updateState: applyJSONpatch
};

export { movieSearchFsmDef };
