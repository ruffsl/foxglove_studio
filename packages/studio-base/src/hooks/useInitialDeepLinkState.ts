// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useEffect, useMemo, useState } from "react";

import Log from "@foxglove/log";
import {
  MessagePipelineContext,
  useMessagePipeline,
} from "@foxglove/studio-base/components/MessagePipeline";
import { useCurrentLayoutActions } from "@foxglove/studio-base/context/CurrentLayoutContext";
import { LayoutData } from "@foxglove/studio-base/context/CurrentLayoutContext/actions";
import { useCurrentUser } from "@foxglove/studio-base/context/CurrentUserContext";
import { EventsStore, useEvents } from "@foxglove/studio-base/context/EventsContext";
import { useLayoutManager } from "@foxglove/studio-base/context/LayoutManagerContext";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import useCallbackWithToast from "@foxglove/studio-base/hooks/useCallbackWithToast";
import { PlayerPresence } from "@foxglove/studio-base/players/types";
import { AppURLState, parseAppURLState } from "@foxglove/studio-base/util/appURLState";
import { windowAppURL } from "@foxglove/studio-base/util/appURLState";

const selectPlayerPresence = (ctx: MessagePipelineContext) => ctx.playerState.presence;
const selectSeek = (ctx: MessagePipelineContext) => ctx.seekPlayback;
const selectSelectEvent = (store: EventsStore) => store.selectEvent;

const log = Log.getLogger(__filename);

/*
 * Separation of sync functions is necessary to prevent memory leak from context kept in
 * useEffect closures. Notably `seekPlayback` being attached to the context of the `useEffect`
 * closures that don't use it and aren't updated when it changes. Otherwise the old memoized callbacks
 * of these functions are kept in React state with the context that includes the old player, preventing
 * garbage collection of the old player.
 */

function useSyncSourceFromUrl(
  targetUrlState: AppURLState | undefined,
  { currentUserRequired }: { currentUserRequired: boolean },
) {
  const [unappliedSourceArgs, setUnappliedSourceArgs] = useState(
    targetUrlState ? { ds: targetUrlState.ds, dsParams: targetUrlState.dsParams } : undefined,
  );
  const { selectSource } = usePlayerSelection();
  const selectEvent = useEvents(selectSelectEvent);
  const { currentUser } = useCurrentUser();
  // Load data source from URL.
  useEffect(() => {
    if (!unappliedSourceArgs) {
      return;
    }

    // Wait for current user session if one is required for this source.
    if (currentUserRequired && !currentUser) {
      return;
    }

    // Apply any available datasource args
    if (unappliedSourceArgs.ds) {
      log.debug("Initialising source from url", unappliedSourceArgs);
      selectSource(unappliedSourceArgs.ds, {
        type: "connection",
        params: unappliedSourceArgs.dsParams,
      });
      selectEvent(unappliedSourceArgs.dsParams?.eventId);
      setUnappliedSourceArgs({ ds: undefined, dsParams: undefined });
    }
  }, [
    currentUser,
    currentUserRequired,
    selectEvent,
    selectSource,
    unappliedSourceArgs,
    setUnappliedSourceArgs,
  ]);
}
function useSyncLayoutFromUrl(
  targetUrlState: AppURLState | undefined,
  { currentUserRequired }: { currentUserRequired: boolean },
) {
  const { setSelectedLayoutId } = useCurrentLayoutActions();
  const playerPresence = useMessagePipeline(selectPlayerPresence);
  const [unappliedLayoutArgs, setUnappliedLayoutArgs] = useState(
    targetUrlState ? { layoutId: targetUrlState.layoutId, layoutUrl: targetUrlState.layoutUrl } : undefined,
  );
  const layoutManager = useLayoutManager();

  const fetchLayoutFromUrl = useCallbackWithToast(async () => {
    if (!unappliedLayoutArgs?.layoutUrl) {
      return;
    }
    const url = new URL(unappliedLayoutArgs.layoutUrl, windowAppURL());
    const layoutName = url.pathname.replace(/.*\//, '')
    log.debug(`Trying to load layout ${layoutName} from ${url}`);
    let res;
    try {
      res = await fetch(url.href);
    } catch {
      log.debug(`Could not load the layout from ${url}`);
      return;
    }
    const parsedState: unknown = JSON.parse(await res.text());

    if (typeof parsedState !== "object" || !parsedState) {
      log.debug(`${url} does not contain valid layout JSON`);
      return;
    }

    const layoutData = parsedState as LayoutData
    const newLayout = await layoutManager.saveNewLayout({
      name: layoutName,
      data: layoutData,
      permission: "CREATOR_WRITE",
    });
    setSelectedLayoutId(newLayout.id);
  }, [layoutManager, unappliedLayoutArgs, setSelectedLayoutId]);

  // Select layout from URL.
  useEffect(() => {
    if (!unappliedLayoutArgs?.layoutUrl && !unappliedLayoutArgs?.layoutId) {
      return;
    }

    // If our datasource requires a current user then wait until the player is
    // available to load the layout since we may need to sync layouts first and
    // that's only possible after the user has logged in.
    if (currentUserRequired && playerPresence !== PlayerPresence.PRESENT) {
      return;
    }

    // Only fetch layout from URL if no ID is selected.
    if (unappliedLayoutArgs.layoutUrl && !unappliedLayoutArgs.layoutId) {
      log.debug(`Fetching layout from layoutUrl: ${unappliedLayoutArgs.layoutUrl}`);
      void fetchLayoutFromUrl();
    }
    else if (unappliedLayoutArgs.layoutId) {
      log.debug(`Selecting layout from layoutId: ${unappliedLayoutArgs.layoutId}`);
      setSelectedLayoutId(unappliedLayoutArgs.layoutId);
    }

    setUnappliedLayoutArgs({ layoutId: undefined, layoutUrl: undefined });
  }, [
    currentUserRequired,
    playerPresence,
    setSelectedLayoutId,
    unappliedLayoutArgs?.layoutId,
    fetchLayoutFromUrl,
    unappliedLayoutArgs?.layoutUrl
  ]);
}

function useSyncTimeFromUrl(targetUrlState: AppURLState | undefined) {
  const seekPlayback = useMessagePipeline(selectSeek);
  const playerPresence = useMessagePipeline(selectPlayerPresence);
  const [unappliedTime, setUnappliedTime] = useState(
    targetUrlState ? { time: targetUrlState.time } : undefined,
  );
  // Seek to time in URL.
  useEffect(() => {
    if (unappliedTime?.time == undefined || !seekPlayback) {
      return;
    }

    // Wait until player is ready before we try to seek.
    if (playerPresence !== PlayerPresence.PRESENT) {
      return;
    }

    log.debug(`Seeking to url time:`, unappliedTime.time);
    seekPlayback(unappliedTime.time);
    setUnappliedTime({ time: undefined });
  }, [playerPresence, seekPlayback, unappliedTime]);
}

/**
 * Ensure only one copy of the hook is mounted so we don't trigger side effects like selectSource
 * more than once.
 */
let useInitialDeepLinkStateMounted = false;
/**
 * Restores our session state from any deep link we were passed on startup.
 */
export function useInitialDeepLinkState(deepLinks: readonly string[]): {
  currentUserRequired: boolean;
} {
  useEffect(() => {
    if (useInitialDeepLinkStateMounted) {
      throw new Error("Invariant: only one copy of useInitialDeepLinkState may be mounted");
    }
    useInitialDeepLinkStateMounted = true;
    return () => {
      useInitialDeepLinkStateMounted = false;
    };
  }, []);

  const { availableSources } = usePlayerSelection();
  const targetUrlState = useMemo(
    () => (deepLinks[0] ? parseAppURLState(new URL(deepLinks[0])) : undefined),
    [deepLinks],
  );

  // Maybe this should be abstracted somewhere but that would require a
  // more intimate interface with this hook and the player selection logic.
  const currentUserRequiredParam = useMemo(() => {
    let currentUserRequired = false;
    const ds = targetUrlState?.ds;
    const foundSource =
      ds == undefined
        ? undefined
        : availableSources.find((source) => source.id === ds || source.legacyIds?.includes(ds));
    if (foundSource) {
      currentUserRequired = foundSource.currentUserRequired ?? false;
    }

    return { currentUserRequired };
  }, [targetUrlState?.ds, availableSources]);
  useSyncSourceFromUrl(targetUrlState, currentUserRequiredParam);
  useSyncLayoutFromUrl(targetUrlState, currentUserRequiredParam);
  useSyncTimeFromUrl(targetUrlState);
  return currentUserRequiredParam;
}
