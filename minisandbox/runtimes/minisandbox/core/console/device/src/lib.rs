//! Disposable, bounded 8250-compatible UART state used for Linux bring-up.
//!
//! This crate deliberately owns no descriptor, thread, parser, VM handle, or
//! interrupt capability. The PVM adapter supplies port accesses and reflects
//! [`Uart::interrupt_pending`] onto its fixed IRQ4 line.

/// First I/O port occupied by the emulated COM1 UART.
pub const BASE: u16 = 0x3f8;

/// Number of consecutive I/O ports occupied by the UART register bank.
pub const PORT_COUNT: u16 = 8;

/// Maximum host-provided bytes retained for a guest that has not consumed them.
pub const RX_CAPACITY: usize = 64;

const INTERRUPT_RECEIVER_LINE_STATUS: u8 = 0x06;
const INTERRUPT_RECEIVED_DATA_AVAILABLE: u8 = 0x04;
const INTERRUPT_TRANSMITTER_EMPTY: u8 = 0x02;
const INTERRUPT_NONE: u8 = 0x01;
const LINE_STATUS_DATA_READY: u8 = 1 << 0;
const LINE_STATUS_OVERRUN_ERROR: u8 = 1 << 1;
const LINE_STATUS_TRANSMITTER_EMPTY: u8 = (1 << 5) | (1 << 6);
const LINE_CONTROL_DIVISOR_LATCH: u8 = 1 << 7;
const INTERRUPT_ENABLE_RECEIVED_DATA: u8 = 1 << 0;
const INTERRUPT_ENABLE_TRANSMITTER_EMPTY: u8 = 1 << 1;
const INTERRUPT_ENABLE_RECEIVER_LINE_STATUS: u8 = 1 << 2;

/// Result of copying one trusted-runtime input slice into the bounded FIFO.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EnqueueResult {
    /// Prefix copied into the FIFO.
    pub accepted: usize,
    /// Suffix rejected because the fixed FIFO was full.
    pub rejected: usize,
}

/// Pure, allocation-free subset of one 8250/16550 COM1 UART.
///
/// The implementation is intentionally limited to the register behavior used
/// by Linux's serial8250 console and TTY paths. Unsupported modem behavior is
/// represented by stable values and can never allocate host resources.
#[derive(Clone, Debug)]
pub struct Uart {
    interrupt_enable: u8,
    line_control: u8,
    modem_control: u8,
    scratch: u8,
    divisor_low: u8,
    divisor_high: u8,
    tx_interrupt_pending: bool,
    rx: [u8; RX_CAPACITY],
    rx_head: usize,
    rx_len: usize,
    overrun: bool,
}

impl Default for Uart {
    fn default() -> Self {
        Self {
            interrupt_enable: 0,
            line_control: 0,
            modem_control: 0,
            scratch: 0,
            divisor_low: 0,
            divisor_high: 0,
            tx_interrupt_pending: false,
            rx: [0; RX_CAPACITY],
            rx_head: 0,
            rx_len: 0,
            overrun: false,
        }
    }
}

impl Uart {
    /// Returns whether `port` belongs to this fixed COM1 register bank.
    #[must_use]
    pub const fn contains(port: u16) -> bool {
        port >= BASE && port < BASE + PORT_COUNT
    }

    /// Copies as much input as fits without allocating or overwriting unread data.
    pub fn enqueue(&mut self, input: &[u8]) -> EnqueueResult {
        let available = RX_CAPACITY - self.rx_len;
        let accepted = input.len().min(available);
        for (offset, byte) in input[..accepted].iter().copied().enumerate() {
            let tail = (self.rx_head + self.rx_len + offset) % RX_CAPACITY;
            self.rx[tail] = byte;
        }
        self.rx_len += accepted;
        let rejected = input.len() - accepted;
        self.overrun |= rejected != 0;
        EnqueueResult { accepted, rejected }
    }

    /// Returns the number of input bytes not yet consumed by the guest.
    #[must_use]
    pub const fn pending_input(&self) -> usize {
        self.rx_len
    }

    /// Returns whether the UART currently requests its fixed interrupt line.
    #[must_use]
    pub const fn interrupt_pending(&self) -> bool {
        self.line_status_interrupt_pending()
            || self.rx_interrupt_pending()
            || self.tx_interrupt_pending()
    }

    /// Reads one UART register value and replicates it across the KVM I/O span.
    pub fn read(&mut self, port: u16, output: &mut [u8]) {
        let offset = port - BASE;
        let value = match offset {
            0 if self.divisor_latch_enabled() => self.divisor_low,
            0 => self.pop_received().unwrap_or(0),
            1 if self.divisor_latch_enabled() => self.divisor_high,
            1 => self.interrupt_enable,
            2 => self.read_interrupt_identification(),
            3 => self.line_control,
            4 => self.modem_control,
            5 => self.read_line_status(),
            6 => 0xb0,
            7 => self.scratch,
            _ => 0xff,
        };
        output.fill(value);
    }

    /// Applies one UART register write and returns bytes transmitted to COM1.
    #[must_use]
    pub fn write<'a>(&mut self, port: u16, data: &'a [u8]) -> Option<&'a [u8]> {
        let offset = port - BASE;
        match offset {
            0 if self.divisor_latch_enabled() => {
                self.divisor_low = data.last().copied().unwrap_or(0);
                None
            }
            0 => {
                self.tx_interrupt_pending = true;
                Some(data)
            }
            1 if self.divisor_latch_enabled() => {
                self.divisor_high = data.last().copied().unwrap_or(0);
                None
            }
            1 => {
                let was_enabled = self.tx_interrupt_enabled();
                self.interrupt_enable = data.last().copied().unwrap_or(0) & 0x0f;
                let is_enabled = self.tx_interrupt_enabled();
                if is_enabled && !was_enabled {
                    self.tx_interrupt_pending = true;
                } else if !is_enabled {
                    self.tx_interrupt_pending = false;
                }
                None
            }
            2 => {
                if let Some(value) = data.last().copied() {
                    if value & (1 << 1) != 0 {
                        self.clear_received();
                    }
                    if value & (1 << 2) != 0 {
                        self.tx_interrupt_pending = false;
                    }
                }
                None
            }
            3 => {
                self.line_control = data.last().copied().unwrap_or(0);
                None
            }
            4 => {
                self.modem_control = data.last().copied().unwrap_or(0);
                None
            }
            7 => {
                self.scratch = data.last().copied().unwrap_or(0);
                None
            }
            _ => None,
        }
    }

    const fn divisor_latch_enabled(&self) -> bool {
        self.line_control & LINE_CONTROL_DIVISOR_LATCH != 0
    }

    const fn rx_interrupt_pending(&self) -> bool {
        self.rx_len != 0 && self.interrupt_enable & INTERRUPT_ENABLE_RECEIVED_DATA != 0
    }

    const fn line_status_interrupt_pending(&self) -> bool {
        self.overrun && self.interrupt_enable & INTERRUPT_ENABLE_RECEIVER_LINE_STATUS != 0
    }

    const fn tx_interrupt_enabled(&self) -> bool {
        self.interrupt_enable & INTERRUPT_ENABLE_TRANSMITTER_EMPTY != 0
    }

    const fn tx_interrupt_pending(&self) -> bool {
        self.tx_interrupt_pending && self.tx_interrupt_enabled()
    }

    fn pop_received(&mut self) -> Option<u8> {
        if self.rx_len == 0 {
            return None;
        }
        let byte = self.rx[self.rx_head];
        self.rx_head = (self.rx_head + 1) % RX_CAPACITY;
        self.rx_len -= 1;
        Some(byte)
    }

    fn clear_received(&mut self) {
        self.rx_head = 0;
        self.rx_len = 0;
        self.overrun = false;
    }

    fn read_interrupt_identification(&mut self) -> u8 {
        if self.line_status_interrupt_pending() {
            INTERRUPT_RECEIVER_LINE_STATUS
        } else if self.rx_interrupt_pending() {
            INTERRUPT_RECEIVED_DATA_AVAILABLE
        } else if self.tx_interrupt_pending() {
            self.tx_interrupt_pending = false;
            INTERRUPT_TRANSMITTER_EMPTY
        } else {
            INTERRUPT_NONE
        }
    }

    fn read_line_status(&mut self) -> u8 {
        let mut status = LINE_STATUS_TRANSMITTER_EMPTY;
        if self.rx_len != 0 {
            status |= LINE_STATUS_DATA_READY;
        }
        if self.overrun {
            status |= LINE_STATUS_OVERRUN_ERROR;
            self.overrun = false;
        }
        status
    }
}

#[cfg(test)]
mod tests {
    use super::{BASE, INTERRUPT_NONE, RX_CAPACITY, Uart};

    fn read(uart: &mut Uart, offset: u16) -> u8 {
        let mut output = [0];
        uart.read(BASE + offset, &mut output);
        output[0]
    }

    fn write(uart: &mut Uart, offset: u16, value: u8) {
        let _ = uart.write(BASE + offset, &[value]);
    }

    #[test]
    fn receive_irq_tracks_ordered_fifo_consumption() {
        let mut uart = Uart::default();
        write(&mut uart, 1, 1);
        assert_eq!(uart.enqueue(b"login\n").accepted, 6);
        assert!(uart.interrupt_pending());
        assert_eq!(read(&mut uart, 2), 0x04);
        assert_eq!(read(&mut uart, 5) & 1, 1);
        assert_eq!(read(&mut uart, 0), b'l');
        assert_eq!(read(&mut uart, 0), b'o');
        assert_eq!(read(&mut uart, 0), b'g');
        assert_eq!(read(&mut uart, 0), b'i');
        assert_eq!(read(&mut uart, 0), b'n');
        assert_eq!(read(&mut uart, 0), b'\n');
        assert!(!uart.interrupt_pending());
        assert_eq!(read(&mut uart, 2), INTERRUPT_NONE);
        assert_eq!(read(&mut uart, 5) & 1, 0);
    }

    #[test]
    fn full_fifo_rejects_suffix_and_reports_one_overrun() {
        let mut uart = Uart::default();
        write(&mut uart, 1, 1 << 2);
        let input = [0x5a; RX_CAPACITY + 3];
        let result = uart.enqueue(&input);
        assert_eq!(result.accepted, RX_CAPACITY);
        assert_eq!(result.rejected, 3);
        assert_eq!(uart.pending_input(), RX_CAPACITY);
        assert_eq!(read(&mut uart, 2), 0x06);
        assert_eq!(read(&mut uart, 5) & 0x03, 0x03);
        assert!(!uart.interrupt_pending());
        assert_eq!(read(&mut uart, 5) & 0x02, 0);
    }

    #[test]
    fn fifo_clear_discards_input_and_irq() {
        let mut uart = Uart::default();
        write(&mut uart, 1, 1);
        let _ = uart.enqueue(b"stale");
        write(&mut uart, 2, 1 << 1);
        assert_eq!(uart.pending_input(), 0);
        assert!(!uart.interrupt_pending());
    }

    #[test]
    fn cloned_uart_has_independent_receive_state() {
        let mut parent = Uart::default();
        let _ = parent.enqueue(b"ab");
        let mut child = parent.clone();
        assert_eq!(read(&mut child, 0), b'a');
        assert_eq!(parent.pending_input(), 2);
        assert_eq!(child.pending_input(), 1);
    }

    #[test]
    fn divisor_latch_does_not_consume_received_data() {
        let mut uart = Uart::default();
        let _ = uart.enqueue(b"x");
        write(&mut uart, 3, 0x80);
        write(&mut uart, 0, 3);
        assert_eq!(read(&mut uart, 0), 3);
        assert_eq!(uart.pending_input(), 1);
        write(&mut uart, 3, 0);
        assert_eq!(read(&mut uart, 0), b'x');
    }
}
