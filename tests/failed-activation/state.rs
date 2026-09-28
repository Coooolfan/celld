use super::*;

fn starting(resume: bool) -> (State, OpId) {
    let mut state = State::new(
        "test",
        Config {
            max_resident: 10,
            max_activations: 10,
            max_evictions: 2,
            max_releases: 2,
            max_outbound_websockets: 10,
            ownership_on_evict: OwnershipOnEvict::Sticky,
            require_node_lease: false,
            peer_protocol: 1,
            operation_deadline_ms: None,
            owner_log_recovery_backoff_ms: 100,
            owner_log_recovery_attempts: 3,
            alarm_resident_ms: 100,
            idle_evict_ms: None,
            pressure: Default::default(),
        },
    );
    let op = state.cell_op("lost");
    let mut cell = Cell::default();
    cell.requests.insert(42);
    cell.held_epoch = Some(7);
    cell.resume_demand = resume;
    state.request_cells.insert(42, "lost".into());
    state.activation_permits.insert("lost".into());
    if resume {
        state.resuming = true;
        state.resuming_cells.insert("lost".into());
    }
    set_phase(
        &mut state.occupied,
        &mut cell,
        Phase::Starting { op, epoch: 7 },
    );
    state.cells.insert("lost".into(), cell);
    (state, op)
}

fn fail(state: &mut State, op: OpId, failure: Failure) -> OpId {
    let mut effects = vec![];
    state.runtime_started(op, None, 1, Err(failure), &mut effects);
    assert_eq!(effects.len(), 1, "失败必须只发出一次安全清理");
    let Effect::StopRuntime {
        op: cleanup,
        ref cell,
        epoch: 7,
        cause: StopCause::StartFailed,
        bounded: false,
    } = effects[0]
    else {
        panic!("意外 effect: {effects:?}");
    };
    assert_eq!(cell, "lost");
    assert!(matches!(state.cells["lost"].phase, Phase::Cleaning { .. }));
    assert!(state.cells["lost"].requests.contains(&42));
    state.validate().unwrap();
    cleanup
}

#[test]
fn failed_start_waits_for_cleanup_and_preserves_error() {
    for failure in [Failure::Definite, Failure::Ambiguous] {
        let (mut state, op) = starting(false);
        let cleanup = fail(&mut state, op, failure);
        let mut effects = vec![];
        // 模拟释放迟迟未完成；两个 wake 来源及重复/过期回调均不能开启新激活。
        for _ in 0..20 {
            state.wake_hint_authorized("lost".into(), 0, WakeHintScope::Fleet, &mut effects);
            state.wake_hint_authorized("lost".into(), 0, WakeHintScope::Owned, &mut effects);
            state.runtime_started(op, None, 1, Err(failure), &mut effects);
            state.runtime_stopped(cleanup + 100, &mut effects);
        }
        assert!(effects.is_empty());
        assert!(matches!(state.cells["lost"].phase, Phase::Cleaning { .. }));
        effects.extend(on_event(&mut state, Event::RuntimeStopped { op: cleanup }));
        assert!(matches!(
            state.cells["lost"].phase,
            Phase::Dormant { epoch: 7 }
        ));
        assert!(effects.iter().any(|e| matches!(
            e,
            Effect::Complete {
                request: 42,
                result: Err(RequestError::RuntimeFailed)
            }
        )));
        state.validate().unwrap();
        effects.clear();
        effects.extend(on_event(&mut state, Event::RuntimeStopped { op: cleanup }));
        assert!(effects.is_empty());
    }
}

#[test]
fn failed_resume_settles_only_after_cleanup() {
    let (mut state, op) = starting(true);
    let cleanup = fail(&mut state, op, Failure::Definite);
    assert!(state.resuming);
    on_event(&mut state, Event::RuntimeStopped { op: cleanup });
    assert!(!state.resuming);
    assert!(!state.cells["lost"].resume_demand);
    state.validate().unwrap();
}

#[test]
fn late_failure_after_fence_still_closes_restored_replica() {
    for result in [Ok(()), Err(Failure::Definite), Err(Failure::Ambiguous)] {
        let (mut state, op) = starting(false);
        state.fence_node(HaltReason::NodeLeaseExpired, &mut vec![]);
        let mut effects = vec![];
        state.runtime_started(op, None, 1, result, &mut effects);
        assert!(matches!(
            effects.as_slice(),
            [Effect::StopRuntime {
                epoch: 7,
                cause: StopCause::Fence,
                bounded: false,
                ..
            }]
        ));
        effects.clear();
        state.runtime_started(op, None, 1, result, &mut effects);
        assert!(effects.is_empty());
    }
}

#[test]
fn fence_during_cleanup_cannot_revive_cell() {
    let (mut state, op) = starting(false);
    let cleanup = fail(&mut state, op, Failure::Definite);
    let mut effects = vec![];
    state.fence_node(HaltReason::NodeLeaseExpired, &mut effects);
    assert!(effects.iter().any(|e| matches!(
        e,
        Effect::StopRuntime {
            cause: StopCause::Fence,
            ..
        }
    )));
    effects.clear();
    effects.extend(on_event(&mut state, Event::RuntimeStopped { op: cleanup }));
    assert!(effects.is_empty());
    assert!(matches!(state.cells["lost"].phase, Phase::Fenced));
}

#[test]
fn successful_start_still_publishes() {
    let (mut state, op) = starting(false);
    let mut effects = vec![];
    state.runtime_started(op, None, 1, Ok(()), &mut effects);
    assert!(matches!(
        effects.as_slice(),
        [Effect::Publish { epoch: 7, .. }]
    ));
    assert!(matches!(
        state.cells["lost"].phase,
        Phase::Publishing { .. }
    ));
}
