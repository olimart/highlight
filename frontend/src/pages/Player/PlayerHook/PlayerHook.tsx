import { useAuthContext } from '@authentication/AuthContext'
import {
	OnSessionPayloadAppendedDocument,
	useGetEventChunksQuery,
	useGetEventChunkUrlQuery,
	useGetSessionIntervalsQuery,
	useGetSessionPayloadQuery,
	useGetSessionQuery,
	useMarkSessionAsViewedMutation,
} from '@graph/hooks'
import { GetSessionQuery } from '@graph/operations'
import { EventType } from '@highlight-run/rrweb'
import {
	customEvent,
	viewportResizeDimension,
} from '@highlight-run/rrweb-types'
import { usefulEvent } from '@pages/Player/components/EventStreamV2/utils'
import {
	CHUNKING_DISABLED_PROJECTS,
	FRAME_MS,
	getEvents,
	getTimeFromReplayer,
	LOOKAHEAD_MS,
	MAX_CHUNK_COUNT,
	PlayerActionType,
	PlayerInitialState,
	PlayerReducer,
	SessionViewability,
	THROTTLED_UPDATE_MS,
} from '@pages/Player/PlayerHook/PlayerState'
import { useTimelineIndicators } from '@pages/Player/TimelineIndicatorsContext/TimelineIndicatorsContext'
import analytics from '@util/analytics'
import { indexedDBFetch, indexedDBString } from '@util/db'
import log from '@util/log'
import { useParams } from '@util/react-router/useParams'
import { timerEnd, timerStart } from '@util/timer/timer'
import useMapRef from '@util/useMapRef'
import { H } from 'highlight.run'
import _ from 'lodash'
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { BooleanParam, useQueryParam } from 'use-query-params'

import { HighlightEvent } from '../HighlightEvent'
import { ReplayerContextInterface, ReplayerState } from '../ReplayerContext'
import {
	findNextSessionInList,
	PlayerSearchParameters,
	toHighlightEvents,
	useSetPlayerTimestampFromSearchParam,
} from './utils'
import usePlayerConfiguration from './utils/usePlayerConfiguration'

export const usePlayer = (): ReplayerContextInterface => {
	const { isLoggedIn, isHighlightAdmin } = useAuthContext()
	const { session_secure_id, project_id } = useParams<{
		session_secure_id: string
		project_id: string
	}>()
	const navigate = useNavigate()
	const [download] = useQueryParam('download', BooleanParam)

	const {
		setPlayerTime: setPlayerTimeToPersistance,
		autoPlaySessions,
		autoPlayVideo,
		showPlayerMouseTail,
		setShowLeftPanel,
		setShowRightPanel,
		skipInactive,
	} = usePlayerConfiguration()

	const [markSessionAsViewed] = useMarkSessionAsViewedMutation()
	const { refetch: rawFetchEventChunkURL } = useGetEventChunkUrlQuery({
		fetchPolicy: 'no-cache',
		skip: true,
	})
	const fetchEventChunkURL = useCallback(
		async function ({
			secure_id,
			index,
		}: {
			secure_id: string
			index: number
		}) {
			const args = {
				secure_id,
				index,
			}
			return (
				(
					await indexedDBString({
						key: JSON.stringify(args),
						operation: 'FetchEventChunkURL',
						fn: async () =>
							(
								await rawFetchEventChunkURL(args)
							).data.event_chunk_url,
					}).next()
				).value || ''
			)
		},
		[rawFetchEventChunkURL],
	)
	const { data: sessionIntervals } = useGetSessionIntervalsQuery({
		variables: {
			session_secure_id: session_secure_id!,
		},
		skip: !session_secure_id,
	})
	const { data: eventChunksData } = useGetEventChunksQuery({
		variables: { secure_id: session_secure_id! },
		skip:
			!session_secure_id ||
			!project_id ||
			CHUNKING_DISABLED_PROJECTS.includes(project_id),
	})
	const { data: sessionData } = useGetSessionQuery({
		variables: {
			secure_id: session_secure_id!,
		},
		onCompleted: useCallback((data: GetSessionQuery) => {
			dispatch({
				type: PlayerActionType.loadSession,
				data,
			})
		}, []),
		onError: useCallback(() => {
			dispatch({
				type: PlayerActionType.loadSession,
				data: { session: undefined },
			})
		}, []),
		skip: !session_secure_id,
		fetchPolicy: 'network-only',
	})
	const { timelineIndicatorEvents } = useTimelineIndicators(
		sessionData?.session || undefined,
	)
	const { data: sessionPayload, subscribeToMore: subscribeToSessionPayload } =
		useGetSessionPayloadQuery({
			fetchPolicy: sessionData?.session?.processed
				? undefined
				: 'no-cache',
			variables: {
				session_secure_id: session_secure_id!,
				skip_events: sessionData?.session
					? !!sessionData.session?.direct_download_url
					: true,
			},
			skip: !session_secure_id,
		})

	// chunk indexes that are currently being loaded (fetched over the network)
	const loadingChunks = useRef<Set<number>>(new Set<number>())
	// the timestamp we are moving to next.
	const target = useRef<{
		time?: number
		state: ReplayerState.Paused | ReplayerState.Playing
	}>({
		state: ReplayerState.Paused,
	})

	const unsubscribeSessionPayloadFn = useRef<(() => void) | null>()
	const animationFrameID = useRef<number>(0)

	const [
		chunkEventsRef,
		chunkEventsSet,
		chunkEventsRemove,
		chunkEventsReset,
	] = useMapRef<number, HighlightEvent[]>()
	const [state, dispatch] = useReducer(PlayerReducer, {
		...PlayerInitialState,
		chunkEventsRef,
		isLoggedIn,
		isHighlightAdmin,
		markSessionAsViewed,
		fetchEventChunkURL,
	})

	const { setPlayerTimestamp } = useSetPlayerTimestampFromSearchParam((t) =>
		seek(t),
	)

	const resetPlayer = useCallback(() => {
		if (unsubscribeSessionPayloadFn.current) {
			unsubscribeSessionPayloadFn.current()
			unsubscribeSessionPayloadFn.current = undefined
		}
		if (animationFrameID.current) {
			cancelAnimationFrame(animationFrameID.current)
			animationFrameID.current = 0
		}

		chunkEventsReset()
		if (!project_id || !session_secure_id) {
			return
		}
		dispatch({
			type: PlayerActionType.reset,
			projectId: project_id,
			sessionSecureId: session_secure_id,
			nextState: ReplayerState.Loading,
		})
	}, [chunkEventsReset, project_id, session_secure_id])

	// Returns the player-relative timestamp of the end of the current inactive interval.
	// Returns undefined if not in an interval or the interval is marked as active.
	const getInactivityEnd = useCallback(
		(time: number): number | undefined => {
			for (const interval of state.sessionIntervals) {
				if (time >= interval.startTime && time < interval.endTime) {
					if (!interval.active) {
						return interval.endTime
					} else {
						return undefined
					}
				}
			}
			return undefined
		},
		[state.sessionIntervals],
	)

	const getChunkIdx = useCallback(
		(ts: number) => {
			let idx = 0
			eventChunksData?.event_chunks?.forEach((chunk, i) => {
				if (chunk.timestamp <= ts) {
					idx = i
				}
			})
			return idx
		},
		[eventChunksData],
	)

	const getChunkTs = useCallback(
		(idx: number) => {
			return eventChunksData?.event_chunks[idx].timestamp
		},
		[eventChunksData],
	)

	// returns loaded chunks that are no longer needed.
	const getChunksToRemove = useCallback(
		(
			chunkEvents: Omit<
				Map<number, HighlightEvent[]>,
				'set' | 'clear' | 'delete'
			>,
			startIdx: number,
		): Set<number> => {
			const toRemove = new Set<number>()
			const chunksIndexesWithData = Array.from(chunkEvents.entries())
				.filter(([, v]) => !!v.length)
				.map(([k]) => k)
			if (chunksIndexesWithData.length <= MAX_CHUNK_COUNT) {
				return toRemove
			}
			chunksIndexesWithData.sort((a, b) => a - b)

			const startTs = getChunkTs(startIdx)
			for (const idx of chunksIndexesWithData) {
				const chunkTs = getChunkTs(idx)
				if (
					idx < startIdx ||
					(chunkTs &&
						startTs &&
						idx >= startIdx + MAX_CHUNK_COUNT &&
						chunkTs > startTs + LOOKAHEAD_MS)
				) {
					toRemove.add(idx)
				}
			}
			return toRemove
		},
		[getChunkTs],
	)

	const getLastLoadedEventTimestamp = useCallback(() => {
		const lastLoadedChunk = Math.max(
			...[...chunkEventsRef.current.entries()]
				.filter(([, v]) => !!v.length)
				.map(([k]) => k),
		)
		return (
			Math.max(
				...(chunkEventsRef.current
					.get(lastLoadedChunk)
					?.map((e) => e.timestamp) || []),
			) - state.sessionMetadata.startTime
		)
	}, [chunkEventsRef, state.sessionMetadata.startTime])

	const dispatchAction = useCallback(
		(time: number, action: ReplayerState) => {
			dispatch({
				type: PlayerActionType.onChunksLoad,
				showPlayerMouseTail,
				time,
				action: action,
			})
		},
		[showPlayerMouseTail],
	)

	const loadEventChunk = useCallback(
		async (_i: number) => {
			loadingChunks.current.add(_i)
			try {
				const url = await fetchEventChunkURL({
					secure_id: session_secure_id!,
					index: _i,
				})
				log('PlayerHook.tsx', 'loading chunk', {
					url,
				})
				const iter = indexedDBFetch(url)
				const chunkResponse = (await iter.next()).value!
				log('PlayerHook.tsx', 'chunk data', {
					chunkResponse,
				})
				log(
					'PlayerHook.tsx:ensureChunksLoaded',
					'set data for chunk',
					_i,
				)
				return {
					idx: _i,
					events: toHighlightEvents(await chunkResponse.json()),
				}
			} catch (e: any) {
				log(e, 'Error direct downloading session payload', {
					chunk: `${_i}`,
				})
			} finally {
				loadingChunks.current.delete(_i)
			}
			return { idx: -1, events: [] }
		},
		[fetchEventChunkURL, session_secure_id],
	)

	// Ensure all chunks between startTs and endTs are loaded.
	const ensureChunksLoaded = useCallback(
		async (
			startTime: number,
			endTime?: number,
			action?: ReplayerState.Playing | ReplayerState.Paused,
			forceLoadNext?: boolean,
		) => {
			if (
				!project_id ||
				CHUNKING_DISABLED_PROJECTS.includes(project_id) ||
				!state.session?.chunked
			) {
				if (action) dispatchAction(startTime, action)
				return
			}

			const startIdx = Math.max(
				0,
				getChunkIdx(state.sessionMetadata.startTime + startTime),
			)
			let endIdx = endTime
				? getChunkIdx(state.sessionMetadata.startTime + endTime)
				: startIdx
			if (forceLoadNext) endIdx += 1

			const lastChunkIdx =
				eventChunksData?.event_chunks[
					eventChunksData?.event_chunks.length - 1
				]?.chunk_index
			if (lastChunkIdx !== undefined)
				endIdx = Math.min(lastChunkIdx, endIdx)

			const promises = []
			log(
				'PlayerHook.tsx:ensureChunksLoaded',
				'checking chunk loaded status range',
				startIdx,
				endIdx,
			)
			for (let i = startIdx; i <= endIdx; i++) {
				log('PlayerHook.tsx:ensureChunksLoaded', 'has', i, {
					has: chunkEventsRef.current.has(i),
				})
				if (chunkEventsRef.current.has(i)) {
					continue
				}

				if (loadingChunks.current.has(i)) {
					log(
						'PlayerHook.tsx:ensureChunksLoaded',
						'waiting for loading chunk',
						i,
					)
				} else {
					// signal that we are loading chunks once
					if (!promises.length) {
						if (i == startIdx) {
							log(
								'PlayerHook.tsx:ensureChunksLoaded',
								'needs blocking load for chunk',
								i,
							)
							dispatch({
								type: PlayerActionType.startChunksLoad,
							})
						}
					}
					promises.push(loadEventChunk(i))
				}
			}
			if (promises.length) {
				const toRemove = getChunksToRemove(
					chunkEventsRef.current,
					startIdx,
				)
				const currentChunkIdx = getChunkIdx(
					state.sessionMetadata.startTime + startTime,
				)
				if (currentChunkIdx) {
					toRemove.delete(currentChunkIdx)
				}
				log('PlayerHook.tsx:ensureChunksLoaded', 'getChunksToRemove', {
					after: chunkEventsRef.current,
					toRemove,
				})
				toRemove.forEach((idx) => chunkEventsRemove(idx))
				// while we wait for the promises to resolve, set the target as a lock for other ensureChunksLoaded
				target.current = {
					time: startTime,
					state: action ?? target.current.state,
				}
				const loadedChunkIds = new Set<number>()
				const loadedChunks = await Promise.all(promises)
				if (
					target.current.time !== startTime ||
					target.current.state !== (action ?? target.current.state)
				) {
					log(
						'PlayerHook.tsx:ensureChunksLoaded',
						'someone else has taken the chunk loading lock',
						{
							startTime,
							action,
							target,
							loadedChunks: loadedChunkIds,
						},
					)
					return
				}
				for (const { idx, events } of loadedChunks) {
					chunkEventsSet(idx, events)
				}
				// update the replayer events
				log(
					'PlayerHook.tsx:ensureChunksLoaded',
					'promises done, updating events',
					{ loadedChunks: loadedChunkIds, target },
				)
				dispatch({ type: PlayerActionType.updateEvents })
			}
			if (action) {
				log(
					'PlayerHook.tsx:ensureChunksLoaded',
					'calling dispatchAction due to action',
					{
						startTime,
						action,
						target,
						chunks: chunkEventsRef.current,
					},
				)
				dispatchAction(startTime, action)
			}
		},
		[
			project_id,
			state.session?.chunked,
			state.sessionMetadata.startTime,
			getChunkIdx,
			eventChunksData?.event_chunks,
			dispatchAction,
			chunkEventsRef,
			loadEventChunk,
			getChunksToRemove,
			chunkEventsRemove,
			chunkEventsSet,
		],
	)

	const play = useCallback(
		(time?: number): Promise<void> => {
			const newTime = time ?? 0
			target.current = { time: newTime, state: ReplayerState.Playing }
			dispatch({ type: PlayerActionType.setTime, time: newTime })
			// Don't play the session if the player is already at the end of the session.
			if (newTime >= state.sessionEndTime) {
				return Promise.resolve()
			}

			timerStart('timelineChangeTime')
			dispatch({ type: PlayerActionType.setTime, time: newTime })
			return new Promise<void>((r) =>
				ensureChunksLoaded(
					newTime,
					undefined,
					ReplayerState.Playing,
				).then(() => {
					// Log how long it took to move to the new time.
					const timelineChangeTime = timerEnd('timelineChangeTime')
					analytics.track('Session play', {
						time,
						duration: timelineChangeTime,
						secure_id: state.session_secure_id,
					})
					r()
				}),
			)
		},
		[ensureChunksLoaded, state.sessionEndTime, state.session_secure_id],
	)

	const pause = useCallback(
		(time?: number) => {
			target.current = {
				time: time,
				state: ReplayerState.Paused,
			}
			return new Promise<void>((r) => {
				if (time !== undefined) {
					timerStart('timelineChangeTime')
					dispatch({ type: PlayerActionType.setTime, time })
					ensureChunksLoaded(
						time,
						undefined,
						ReplayerState.Paused,
					).then(() => {
						// Log how long it took to move to the new time.
						const timelineChangeTime =
							timerEnd('timelineChangeTime')
						analytics.track('Session pause', {
							time,
							duration: timelineChangeTime,
							secure_id: state.session_secure_id,
						})
						r()
					})
				} else {
					dispatch({ type: PlayerActionType.pause })
					r()
				}
			})
		},
		[ensureChunksLoaded, state.session_secure_id],
	)

	const seek = useCallback(
		(time: number): Promise<void> => {
			target.current = {
				time: time,
				state: target.current.state,
			}
			return new Promise<void>((r) => {
				timerStart('timelineChangeTime')
				if (skipInactive) {
					const inactivityEnd = getInactivityEnd(time)
					if (inactivityEnd) {
						log(
							'PlayerHook.tsx',
							'seeking to',
							inactivityEnd,
							'due to inactivity at seek requested for',
							time,
						)
						time = inactivityEnd
					}
				}
				const desiredState =
					state.replayerState === ReplayerState.Paused
						? ReplayerState.Paused
						: ReplayerState.Playing
				log('PlayerHook.tsx', 'seeking to', { time, desiredState })
				dispatch({ type: PlayerActionType.setTime, time })
				ensureChunksLoaded(time, undefined, desiredState).then(() => {
					// Log how long it took to move to the new time.
					const timelineChangeTime = timerEnd('timelineChangeTime')
					analytics.track('Session seek', {
						time,
						duration: timelineChangeTime,
						secure_id: state.session_secure_id,
					})
					r()
				})
			})
		},
		[
			ensureChunksLoaded,
			getInactivityEnd,
			skipInactive,
			state.replayerState,
			state.session_secure_id,
		],
	)

	const onFrameOrEvent = useMemo(
		() =>
			_.throttle(
				(event?: HighlightEvent) => {
					if (event) {
						dispatch({
							type: PlayerActionType.onEvent,
							event: event,
						})
						return
					}
					const lastLoadedEventTimestamp =
						getLastLoadedEventTimestamp()
					if (state.time > lastLoadedEventTimestamp) {
						log(
							'PlayerHook.tsx::onFrame',
							'playing outside loaded data',
							{
								time: state.time,
								lastLoadedEventTimestamp,
							},
						)
						play(state.time).then()
					}
					dispatch({
						type: PlayerActionType.onFrame,
					})
				},
				THROTTLED_UPDATE_MS,
				{ leading: true, trailing: false },
			),
		// we want to keep this throttled fn reference stable
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[],
	)

	const onEvent = useCallback(
		(event: HighlightEvent) => {
			if (
				(event.type === EventType.Custom &&
					(event.data.tag === 'Navigate' ||
						event.data.tag === 'Reload')) ||
				(event as customEvent)?.data?.tag === 'Stop'
			) {
				dispatch({
					type: PlayerActionType.onEvent,
					event: event,
				})
			} else if (usefulEvent(event)) {
				onFrameOrEvent(event)
			}
		},
		[onFrameOrEvent],
	)

	// eslint-disable-next-line react-hooks/exhaustive-deps
	const onPlayStartStop = useCallback(
		_.throttle(() => {
			if (!state.replayer) return
			dispatch({
				type: PlayerActionType.updateCurrentUrl,
				currentTime:
					getTimeFromReplayer(state.replayer, state.sessionMetadata) +
					state.sessionMetadata.startTime,
			})
		}, FRAME_MS * 60),
		[],
	)

	// eslint-disable-next-line react-hooks/exhaustive-deps
	const onViewportChange = useCallback(
		_.throttle((_e) => {
			dispatch({
				type: PlayerActionType.updateViewport,
				viewport: _e as viewportResizeDimension,
			})
		}, FRAME_MS * 60),
		[],
	)

	// Initializes the session state and fetches the session data
	useEffect(() => {
		resetPlayer()
		if (session_secure_id && eventChunksData?.event_chunks?.length) {
			loadEventChunk(0)
				.then(({ events }) => {
					chunkEventsSet(0, events)
					dispatch({
						type: PlayerActionType.onChunksLoad,
						showPlayerMouseTail,
						time: 0,
						action: ReplayerState.Paused,
					})
					log('PlayerHook.tsx', 'initial chunk complete')
				})
				.then(() => {
					const nextChunk = eventChunksData.event_chunks.at(1)
					if (nextChunk) {
						loadEventChunk(nextChunk.chunk_index).then(
							({ idx, events }) => {
								chunkEventsSet(idx, events)
								log(
									'PlayerHook.tsx',
									'next chunk load complete',
								)
							},
						)
					}
				})
		}
	}, [
		project_id,
		session_secure_id,
		resetPlayer,
		loadEventChunk,
		eventChunksData?.event_chunks,
		showPlayerMouseTail,
		chunkEventsSet,
	])

	useEffect(() => {
		if (!state.replayer) return
		if (
			state.isLiveMode &&
			sessionPayload?.events &&
			!unsubscribeSessionPayloadFn.current &&
			subscribeToSessionPayload
		) {
			log('PlayerHook.tsx', 'live mode subscribing')
			unsubscribeSessionPayloadFn.current = subscribeToSessionPayload({
				document: OnSessionPayloadAppendedDocument,
				variables: {
					session_secure_id,
					initial_events_count: sessionPayload.events.length,
				},
				updateQuery: (prev, { subscriptionData }) => {
					log('PlayerHook.tsx', 'live mode update', {
						subscriptionData,
					})
					if (subscriptionData.data) {
						const sd = subscriptionData.data
						// @ts-ignore The typedef for subscriptionData is incorrect, apollo creates _appended type
						const newEvents = sd!.session_payload_appended.events!
						if (newEvents.length) {
							const events = [
								...(chunkEventsRef.current.get(0) || []),
								...toHighlightEvents(newEvents),
							]
							chunkEventsSet(0, events)
							dispatch({
								type: PlayerActionType.addLiveEvents,
								firstNewTimestamp:
									toHighlightEvents(newEvents)[0].timestamp,
								lastActiveTimestamp: new Date(
									// @ts-ignore The typedef for subscriptionData is incorrect, apollo creates _appended type
									subscriptionData.data!.session_payload_appended.last_user_interaction_time,
								).getTime(),
							})
						}
					}
					// Prev is the value in Apollo cache - it is empty, don't bother updating it
					return prev
				},
			})
			play(state.time).then()
		} else if (!state.isLiveMode && unsubscribeSessionPayloadFn.current) {
			log('PlayerHook.tsx', 'live mode unsubscribing')
			unsubscribeSessionPayloadFn.current()
			unsubscribeSessionPayloadFn.current = undefined
			pause(0).then()
		}
		// We don't want to re-evaluate this every time the play/pause fn changes
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		state.isLiveMode,
		sessionPayload?.events,
		state.replayer,
		state.replayerState,
		subscribeToSessionPayload,
		session_secure_id,
		chunkEventsSet,
	])

	useEffect(() => {
		if (state.replayer && state.session?.secure_id !== session_secure_id) {
			dispatch({
				type: PlayerActionType.updateCurrentUrl,
				currentTime:
					getTimeFromReplayer(state.replayer, state.sessionMetadata) +
					state.sessionMetadata.startTime,
			})
		}
	}, [
		state.session?.secure_id,
		session_secure_id,
		state.replayer,
		state.sessionMetadata,
	])

	useEffect(() => {
		const searchParamsObject = new URLSearchParams(location.search)
		if (searchParamsObject.get(PlayerSearchParameters.errorId)) {
			setShowLeftPanel(false)
			setShowRightPanel(true)
		}
	}, [setShowLeftPanel, setShowRightPanel])

	// set event listeners for the replayer
	useEffect(() => {
		if (!state.replayer) {
			return
		}
		state.replayer.on('event-cast', (e: any) =>
			onEvent(e as HighlightEvent),
		)
		state.replayer.on('resize', onViewportChange)
		state.replayer.on('pause', onPlayStartStop)
		state.replayer.on('start', onPlayStartStop)
	}, [state.replayer, project_id, onEvent, onViewportChange, onPlayStartStop])

	// Downloads the events data only if the URL search parameter '?download=1' is present.
	useEffect(() => {
		if (download) {
			const directDownloadUrl = sessionData?.session?.direct_download_url

			if (directDownloadUrl) {
				const handleDownload = (events: HighlightEvent[]): void => {
					const a = document.createElement('a')
					const file = new Blob([JSON.stringify(events)], {
						type: 'application/json',
					})

					a.href = URL.createObjectURL(file)
					a.download = `session-${session_secure_id}.json`
					a.click()

					URL.revokeObjectURL(a.href)
				}

				fetch(directDownloadUrl)
					.then((response) => response.json())
					.then((data) => {
						return toHighlightEvents(data || [])
					})
					.then(handleDownload)
					.catch((e) => {
						H.consumeError(
							e,
							'Error direct downloading session payload for download',
						)
					})
			}
		}
	}, [download, sessionData?.session?.direct_download_url, session_secure_id])

	useEffect(() => {
		// If events are returned by getSessionPayloadQuery, set the events payload
		if (!!sessionPayload?.events?.length) {
			chunkEventsSet(0, toHighlightEvents(sessionPayload?.events))
			dispatchAction(0, ReplayerState.Paused)
		}
		dispatch({
			type: PlayerActionType.onChunksLoad,
			showPlayerMouseTail,
			time: 0,
			action: ReplayerState.Paused,
		})
		dispatch({
			type: PlayerActionType.onSessionPayloadLoaded,
			sessionPayload,
			sessionIntervals,
			timelineIndicatorEvents,
		})
		if (state.replayerState <= ReplayerState.Loading) {
			pause(0).then()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		sessionPayload,
		sessionIntervals,
		timelineIndicatorEvents,
		chunkEventsSet,
	])

	useEffect(() => {
		setPlayerTimestamp(
			state.sessionMetadata.totalTime,
			state.sessionMetadata.startTime,
			state.errors,
		)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state.sessionMetadata])

	useEffect(() => {
		if (state.replayer) {
			state.replayer.setConfig({ mouseTail: showPlayerMouseTail })
		}
	}, [state.replayer, showPlayerMouseTail])

	const frameAction = useCallback(() => {
		animationFrameID.current = requestAnimationFrame(frameAction)
		onFrameOrEvent()
	}, [onFrameOrEvent])

	// "Subscribes" the time with the Replayer when the Player is playing.
	useEffect(() => {
		if (
			(state.replayerState === ReplayerState.Playing ||
				state.isLiveMode) &&
			!animationFrameID.current
		) {
			animationFrameID.current = requestAnimationFrame(frameAction)
		} else if (
			!(state.replayerState === ReplayerState.Playing || state.isLiveMode)
		) {
			cancelAnimationFrame(animationFrameID.current)
			animationFrameID.current = 0
		}
		return () => {
			cancelAnimationFrame(animationFrameID.current)
			animationFrameID.current = 0
		}
	}, [
		frameAction,
		session_secure_id,
		state.isLiveMode,
		state.replayer,
		state.replayerState,
	])

	useEffect(() => {
		setPlayerTimeToPersistance(state.time)
	}, [setPlayerTimeToPersistance, state.time])

	// Finds the next session in the session feed to play if autoplay is enabled.
	useEffect(() => {
		if (
			!!session_secure_id &&
			state.replayerState === ReplayerState.SessionEnded &&
			autoPlaySessions &&
			state.sessionResults.sessions.length > 0
		) {
			const nextSessionInList = findNextSessionInList(
				state.sessionResults.sessions,
				session_secure_id,
			)

			if (nextSessionInList) {
				pause(state.time).then(() => {
					resetPlayer()
					navigate(
						`/${project_id}/sessions/${nextSessionInList.secure_id}`,
					)
				})
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		autoPlaySessions,
		pause,
		project_id,
		resetPlayer,
		session_secure_id,
		state.replayerState,
		state.sessionResults.sessions,
	])

	// ensures that chunks are loaded in advance during playback
	// ensures we skip over inactivity periods
	useEffect(() => {
		if (
			state.sessionMetadata.startTime === 0 ||
			state.replayerState !== ReplayerState.Playing ||
			session_secure_id !== state.session_secure_id
		) {
			return
		}
		// If the player is in an inactive interval, skip to the end of it
		let inactivityEnd: number | undefined
		if (skipInactive && state.replayerState === ReplayerState.Playing) {
			inactivityEnd = getInactivityEnd(state.time)
			if (inactivityEnd !== undefined) {
				log(
					'PlayerHook.tsx',
					'seeking to',
					inactivityEnd,
					'due to inactivity at',
					state.time,
				)
				play(inactivityEnd).then()
				return
			}
		}
		ensureChunksLoaded(
			state.time,
			state.time + LOOKAHEAD_MS,
			undefined,
			getLastLoadedEventTimestamp() - state.time < LOOKAHEAD_MS,
		).then()
	}, [
		state.time,
		ensureChunksLoaded,
		state.sessionMetadata.startTime,
		state.replayerState,
		skipInactive,
		getInactivityEnd,
		play,
		state.session_secure_id,
		session_secure_id,
		chunkEventsRef,
		getLastLoadedEventTimestamp,
	])

	useEffect(() => {
		if (
			state.eventsLoaded &&
			autoPlayVideo &&
			state.replayerState !== ReplayerState.Playing
		) {
			log('PlayerHook.tsx', 'Auto Playing')
			dispatch({
				type: PlayerActionType.play,
				time: 0,
			})
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [autoPlayVideo, state.eventsLoaded])

	return {
		...state,
		setScale: useCallback(
			(scale) => dispatch({ type: PlayerActionType.setScale, scale }),
			[],
		),
		setTime: seek,
		state: state.replayerState,
		play,
		pause,
		canViewSession:
			state.sessionViewability === SessionViewability.VIEWABLE,
		setSessionResults: useCallback(
			(sessionResults) =>
				dispatch({
					type: PlayerActionType.setSessionResults,
					sessionResults,
				}),
			[],
		),
		isPlayerReady:
			state.replayerState !== ReplayerState.Loading &&
			state.replayerState !== ReplayerState.Empty &&
			state.scale !== 1 &&
			state.sessionViewability === SessionViewability.VIEWABLE,
		setIsLiveMode: useCallback(
			(isLiveMode) => {
				if (state.isLiveMode) {
					// TODO: This probably takes a while, add a loading state or break this
					// into a separate action. Also, not positive this is working as it
					// doesn't seem to be adding the latest events to the player.
					const events = getEvents(chunkEventsRef.current)

					dispatch({
						type: PlayerActionType.addLiveEvents,
						lastActiveTimestamp: state.lastActiveTimestamp,
						firstNewTimestamp: events[events.length - 1].timestamp,
					})
				}
				dispatch({ type: PlayerActionType.setIsLiveMode, isLiveMode })
			},
			[chunkEventsRef, state.isLiveMode, state.lastActiveTimestamp],
		),
		playerProgress: state.replayer
			? state.time / state.sessionMetadata.totalTime
			: null,
		sessionStartDateTime: state.sessionMetadata.startTime,
		setCurrentEvent: useCallback(
			(currentEvent) =>
				dispatch({
					type: PlayerActionType.setCurrentEvent,
					currentEvent,
				}),
			[],
		),
	}
}
