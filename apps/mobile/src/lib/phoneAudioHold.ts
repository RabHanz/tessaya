// A Sleeve's or Tessel's link owns T3PhoneAudio from open to close; dictation uses it only while no link does.
let held = 0;
export const holdPhoneAudio = (): (() => void) => {
  held++;
  return () => void held--;
};
export const phoneAudioHeld = (): boolean => held > 0;
