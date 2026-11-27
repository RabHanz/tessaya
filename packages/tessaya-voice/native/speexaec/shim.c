#include "config.h"
#include <stdlib.h>
#include "speex/speex_echo.h"
#include "speex/speex_preprocess.h"
typedef struct { SpeexEchoState *e; SpeexPreprocessState *p; int frame; } aec_t;
/* frame: samples per call (10-20 ms); filter: echo tail in samples; suppress: residual echo cut (dB, negative, 0 = off) */
aec_t *aec_create(int frame, int filter, int rate, int suppress, int suppressActive, int noise) {
  aec_t *a = malloc(sizeof *a);
  a->frame = frame;
  a->e = speex_echo_state_init(frame, filter);
  speex_echo_ctl(a->e, SPEEX_ECHO_SET_SAMPLING_RATE, &rate);
  a->p = 0;
  if (suppress < 0) {
    a->p = speex_preprocess_state_init(frame, rate);
    int off = 0, on = 1;
    speex_preprocess_ctl(a->p, SPEEX_PREPROCESS_SET_AGC, &off);
    speex_preprocess_ctl(a->p, SPEEX_PREPROCESS_SET_VAD, &off);
    speex_preprocess_ctl(a->p, SPEEX_PREPROCESS_SET_DEREVERB, &off);
    speex_preprocess_ctl(a->p, SPEEX_PREPROCESS_SET_DENOISE, &on);
    speex_preprocess_ctl(a->p, SPEEX_PREPROCESS_SET_NOISE_SUPPRESS, &noise);
    speex_preprocess_ctl(a->p, SPEEX_PREPROCESS_SET_ECHO_SUPPRESS, &suppress);
    speex_preprocess_ctl(a->p, SPEEX_PREPROCESS_SET_ECHO_SUPPRESS_ACTIVE, &suppressActive);
    speex_preprocess_ctl(a->p, SPEEX_PREPROCESS_SET_ECHO_STATE, a->e);
  }
  return a;
}
void *aec_buf(int bytes) { return malloc(bytes); }
void aec_process(aec_t *a, const short *mic, const short *ref, short *out) {
  speex_echo_cancellation(a->e, mic, ref, out);
  if (a->p) speex_preprocess_run(a->p, out);
}
void aec_reset(aec_t *a) { speex_echo_state_reset(a->e); }
void aec_free(aec_t *a) { speex_echo_state_destroy(a->e); if (a->p) speex_preprocess_state_destroy(a->p); free(a); }
