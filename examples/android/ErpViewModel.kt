package com.yourerp.mips.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.yourerp.mips.data.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Screen state. Consume it from Compose:
 *
 *   val state by viewModel.state.collectAsStateWithLifecycle()
 *   when {
 *       state.loading -> LoadingScreen()
 *       state.error != null -> ErrorScreen(state.error!!) { viewModel.loadDashboard() }
 *       else -> DashboardContent(state)
 *   }
 */
data class ErpUiState(
    val loading: Boolean = false,
    val loginLoading: Boolean = false,
    val error: ErpError? = null,
    val loggedIn: Boolean = false,
    val profile: Profile? = null,
    val subjects: List<Subject> = emptyList(),
    val attendance: Attendance? = null,
    val assessment: Assessment? = null,
    val timetable: Timetable? = null,
    val notices: List<Notice> = emptyList(),
    val holidays: List<Holiday> = emptyList(),
    /** Set while the manual-captcha sheet should be visible. */
    val captcha: CaptchaResponse? = null,
    val captchaError: String? = null,
)

class ErpViewModel(
    private val repo: ErpRepository = ErpRepository(),
) : ViewModel() {

    private val _state = MutableStateFlow(ErpUiState(loggedIn = TokenStore.isLoggedIn))
    val state: StateFlow<ErpUiState> = _state.asStateFlow()

    // ------------------------------------------------------------------ auth

    fun login(userId: String, password: String) {
        _state.update { it.copy(loginLoading = true, error = null) }
        viewModelScope.launch {
            repo.login(userId.trim(), password)
                .onSuccess {
                    _state.update { s -> s.copy(loginLoading = false, loggedIn = true) }
                    loadDashboard()
                }
                .onFailure { e ->
                    _state.update {
                        it.copy(loginLoading = false, error = (e as? ErpException)?.error ?: ErpError.Unexpected("login"))
                    }
                }
        }
    }

    /** Manual captcha, step 1 — fetch an image to show the user. */
    fun startManualCaptcha() {
        viewModelScope.launch {
            repo.requestCaptcha()
                .onSuccess { c -> _state.update { it.copy(captcha = c, captchaError = null) } }
                .onFailure { e ->
                    _state.update { it.copy(error = (e as? ErpException)?.error) }
                }
        }
    }

    /** Manual captcha, step 2 — submit the typed answer. */
    fun submitCaptcha(userId: String, password: String, answer: String) {
        val sessionId = _state.value.captcha?.sessionId ?: return
        viewModelScope.launch {
            repo.loginWithCaptcha(sessionId, userId.trim(), password, answer)
                .onSuccess {
                    _state.update { it.copy(captcha = null, loggedIn = true) }
                    loadDashboard()
                }
                .onFailure { e ->
                    // a wrong captcha returns a fresh image; keep the sheet open
                    _state.update {
                        it.copy(captchaError = (e as? ErpException)?.error?.userMessage ?: "Captcha rejected")
                    }
                    startManualCaptcha()
                }
        }
    }

    fun dismissCaptcha() = _state.update { it.copy(captcha = null, captchaError = null) }

    fun logout() {
        viewModelScope.launch {
            repo.logout()
            _state.value = ErpUiState(loggedIn = false)
        }
    }

    // ------------------------------------------------------------------ data

    fun loadDashboard() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            // independent panels — fire them together
            val profile = repo.profile()
            val attendance = repo.attendance()
            val timetable = repo.timetable()
            val notices = repo.notices(limit = 20)

            val failure = listOf(profile, attendance, timetable, notices)
                .firstOrNull { it.isFailure }
                ?.exceptionOrNull() as? ErpException

            _state.update { s ->
                s.copy(
                    loading = false,
                    error = failure?.error,
                    profile = profile.getOrNull() ?: s.profile,
                    attendance = attendance.getOrNull() ?: s.attendance,
                    timetable = timetable.getOrNull() ?: s.timetable,
                    notices = notices.getOrNull()?.notices ?: s.notices,
                )
            }
        }
    }

    fun loadSubjectsAndMarks() {
        viewModelScope.launch {
            repo.subjects().onSuccess { list -> _state.update { it.copy(subjects = list) } }
            repo.assessment().onSuccess { a -> _state.update { it.copy(assessment = a) } }
            repo.holidays().onSuccess { h -> _state.update { it.copy(holidays = h) } }
        }
    }

    fun clearError() = _state.update { it.copy(error = null) }
}
