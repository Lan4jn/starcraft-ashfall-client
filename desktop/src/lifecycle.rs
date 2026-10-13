#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    FreezeAndFlush,
    Wait,
    AskRetryOrDiscard,
    StayOpen,
    Shutdown,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum State {
    #[default]
    Open,
    Saving,
    Failed,
    Closing,
}

#[derive(Debug, Default)]
pub struct CloseMachine {
    state: State,
}

impl CloseMachine {
    pub fn request(&mut self) -> CloseAction {
        match self.state {
            State::Open => {
                self.state = State::Saving;
                CloseAction::FreezeAndFlush
            }
            State::Saving | State::Failed => CloseAction::Wait,
            State::Closing => CloseAction::Shutdown,
        }
    }

    pub fn failed(&mut self) -> CloseAction {
        if self.state == State::Saving {
            self.state = State::Failed;
            CloseAction::AskRetryOrDiscard
        } else {
            CloseAction::Wait
        }
    }

    pub fn cancel(&mut self) -> CloseAction {
        self.state = State::Open;
        CloseAction::StayOpen
    }

    pub fn retry(&mut self) -> CloseAction {
        self.state = State::Saving;
        CloseAction::FreezeAndFlush
    }

    pub fn confirm_saved(&mut self) -> CloseAction {
        if self.state == State::Saving {
            self.state = State::Closing;
            CloseAction::Shutdown
        } else {
            CloseAction::Wait
        }
    }

    pub fn discard(&mut self) -> CloseAction {
        self.state = State::Closing;
        CloseAction::Shutdown
    }
}
