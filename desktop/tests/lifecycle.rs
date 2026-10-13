use ashfall_desktop::lifecycle::{CloseAction, CloseMachine};

#[test]
fn save_failure_does_not_silently_exit() {
    let mut close = CloseMachine::default();
    assert_eq!(close.request(), CloseAction::FreezeAndFlush);
    assert_eq!(close.failed(), CloseAction::AskRetryOrDiscard);
    assert_eq!(close.cancel(), CloseAction::StayOpen);
    assert_eq!(close.request(), CloseAction::FreezeAndFlush);
    assert_eq!(close.confirm_saved(), CloseAction::Shutdown);
}

#[test]
fn repeated_close_does_not_duplicate_flush() {
    let mut close = CloseMachine::default();
    assert_eq!(close.request(), CloseAction::FreezeAndFlush);
    assert_eq!(close.request(), CloseAction::Wait);
    assert_eq!(close.failed(), CloseAction::AskRetryOrDiscard);
    assert_eq!(close.retry(), CloseAction::FreezeAndFlush);
    assert_eq!(close.discard(), CloseAction::Shutdown);
    assert_eq!(close.request(), CloseAction::Shutdown);
}
