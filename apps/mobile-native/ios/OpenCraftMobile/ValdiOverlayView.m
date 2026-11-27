#import "ValdiOverlayView.h"

#import <OpenCraftValdi/SCValdiConfiguration.h>
#import <OpenCraftValdi/SCValdiContextProtocol.h>
#import <OpenCraftValdi/SCValdiFunctionWithBlock.h>
#import <OpenCraftValdi/SCValdiMarshaller.h>
#import <OpenCraftValdi/SCValdiRuntime.h>
#import <OpenCraftValdi/SCValdiRuntimeManager.h>
#import <OpenCraftValdi/UIView+ValdiObjects.h>

static SCValdiRuntime *OpenCraftValdiMainRuntime(void) {
    static SCValdiRuntimeManager *manager;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        manager = [SCValdiRuntimeManager new];
        [manager updateConfiguration:^(SCValdiConfiguration *configuration) {
#if DEBUG
            BOOL enableHotReload = [[[NSProcessInfo processInfo] environment][@"OPENCRAFT_VALDI_HOTRELOAD"] isEqualToString:@"1"];
            configuration.enableDebuggerService = enableHotReload;
            configuration.disableHotReloader = !enableHotReload;
            if (enableHotReload) {
                configuration.debuggerServicePort = 8171;
            }
#else
            configuration.enableDebuggerService = NO;
            configuration.disableHotReloader = YES;
#endif
        }];
    });
    return manager.mainRuntime;
}

static void PerformSystemHaptic(NSString *style) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if ([style isEqualToString:@"light"]) {
            UIImpactFeedbackGenerator *gen = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight];
            [gen impactOccurred];
        } else if ([style isEqualToString:@"medium"]) {
            UIImpactFeedbackGenerator *gen = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleMedium];
            [gen impactOccurred];
        } else {
            UISelectionFeedbackGenerator *gen = [UISelectionFeedbackGenerator new];
            [gen selectionChanged];
        }
    });
}

@implementation ValdiOverlayView {
    UIView *_valdiContent;
    NSDictionary<NSString *, id> *_lastState;
    CGFloat _safeTop;
    CGFloat _safeBottom;
    CGFloat _safeRight;
    CGFloat _keyboardHeight;
    BOOL _interactiveModal;
    BOOL _floatingControlVisible;
}

- (instancetype)initWithFrame:(CGRect)frame {
    self = [super initWithFrame:frame];
    if (self) {
        self.backgroundColor = [UIColor clearColor];
        self.opaque = NO;
        _lastState = @{@"mode": @"idle"};
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                 selector:@selector(handleKeyboardNotification:)
                                                     name:UIKeyboardWillChangeFrameNotification
                                                   object:nil];
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                 selector:@selector(handleKeyboardNotification:)
                                                     name:UIKeyboardWillHideNotification
                                                   object:nil];
    }
    return self;
}

- (void)dealloc {
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (void)triggerHapticStyle:(NSString *)style {
    PerformSystemHaptic(style ?: @"selection");
}

- (NSDictionary<NSString *, id> *)buildMergedViewModel {
    NSMutableDictionary<NSString *, id> *vm = [_lastState mutableCopy] ?: [NSMutableDictionary dictionary];
    vm[@"safeAreaTop"] = @(_safeTop);
    vm[@"safeAreaBottom"] = @(_safeBottom);
    vm[@"keyboardHeight"] = @(_keyboardHeight);

    __weak typeof(self) weakSelf = self;
    vm[@"onHaptic"] = [SCValdiFunctionWithBlock functionWithBlock:^BOOL(SCValdiMarshaller *marshaller) {
        NSString *style = [SCValdiMarshallerGetString(marshaller, 0) copy] ?: @"selection";
        PerformSystemHaptic(style);
        return YES;
    }];
    vm[@"onOpenSourceSettings"] = [SCValdiFunctionWithBlock functionWithBlock:^BOOL(SCValdiMarshaller *marshaller) {
        dispatch_async(dispatch_get_main_queue(), ^{
            __strong typeof(weakSelf) strongSelf = weakSelf;
            if (strongSelf && strongSelf.onOpenSourceSettings) {
                strongSelf.onOpenSourceSettings();
            }
        });
        return YES;
    }];
    vm[@"onCloseOverlay"] = [SCValdiFunctionWithBlock functionWithBlock:^BOOL(SCValdiMarshaller *marshaller) {
        dispatch_async(dispatch_get_main_queue(), ^{
            __strong typeof(weakSelf) strongSelf = weakSelf;
            if (strongSelf && strongSelf.onCloseOverlay) {
                strongSelf.onCloseOverlay();
            }
        });
        return YES;
    }];
    vm[@"onSaveSource"] = [SCValdiFunctionWithBlock functionWithBlock:^BOOL(SCValdiMarshaller *marshaller) {
        NSString *kind = [SCValdiMarshallerGetString(marshaller, 0) copy] ?: @"bundled";
        NSString *url = [SCValdiMarshallerGetString(marshaller, 1) copy] ?: @"";
        dispatch_async(dispatch_get_main_queue(), ^{
            __strong typeof(weakSelf) strongSelf = weakSelf;
            if (strongSelf && strongSelf.onSaveSource) {
                strongSelf.onSaveSource(kind, url);
            }
        });
        return YES;
    }];
    vm[@"onConfirmResult"] = [SCValdiFunctionWithBlock functionWithBlock:^BOOL(SCValdiMarshaller *marshaller) {
        BOOL confirmed = SCValdiMarshallerGetBool(marshaller, 0);
        dispatch_async(dispatch_get_main_queue(), ^{
            __strong typeof(weakSelf) strongSelf = weakSelf;
            if (strongSelf && strongSelf.onConfirmResult) {
                strongSelf.onConfirmResult(confirmed);
            }
        });
        return YES;
    }];
    vm[@"onActionSheetResult"] = [SCValdiFunctionWithBlock functionWithBlock:^BOOL(SCValdiMarshaller *marshaller) {
        NSString *actionId = [SCValdiMarshallerGetString(marshaller, 0) copy];
        dispatch_async(dispatch_get_main_queue(), ^{
            __strong typeof(weakSelf) strongSelf = weakSelf;
            if (strongSelf && strongSelf.onActionSheetResult) {
                strongSelf.onActionSheetResult(actionId.length > 0 ? actionId : nil);
            }
        });
        return YES;
    }];
    vm[@"onWelcomeConnect"] = [SCValdiFunctionWithBlock functionWithBlock:^BOOL(SCValdiMarshaller *marshaller) {
        dispatch_async(dispatch_get_main_queue(), ^{
            __strong typeof(weakSelf) strongSelf = weakSelf;
            if (strongSelf && strongSelf.onWelcomeConnect) {
                strongSelf.onWelcomeConnect();
            }
        });
        return YES;
    }];
    vm[@"onWelcomeExplore"] = [SCValdiFunctionWithBlock functionWithBlock:^BOOL(SCValdiMarshaller *marshaller) {
        dispatch_async(dispatch_get_main_queue(), ^{
            __strong typeof(weakSelf) strongSelf = weakSelf;
            if (strongSelf && strongSelf.onWelcomeExplore) {
                strongSelf.onWelcomeExplore();
            }
        });
        return YES;
    }];
    vm[@"onWelcomeStyleLab"] = [SCValdiFunctionWithBlock functionWithBlock:^BOOL(SCValdiMarshaller *marshaller) {
        dispatch_async(dispatch_get_main_queue(), ^{
            __strong typeof(weakSelf) strongSelf = weakSelf;
            if (strongSelf && strongSelf.onWelcomeStyleLab) {
                strongSelf.onWelcomeStyleLab();
            }
        });
        return YES;
    }];
    vm[@"onWelcomeThemePref"] = [SCValdiFunctionWithBlock functionWithBlock:^BOOL(SCValdiMarshaller *marshaller) {
        NSString *pref = [SCValdiMarshallerGetString(marshaller, 0) copy] ?: @"system";
        dispatch_async(dispatch_get_main_queue(), ^{
            __strong typeof(weakSelf) strongSelf = weakSelf;
            if (strongSelf && strongSelf.onWelcomeThemePref) {
                strongSelf.onWelcomeThemePref(pref);
            }
        });
        return YES;
    }];
    return vm;
}

- (void)ensureValdiMounted {
    if (_valdiContent) return;
    NSError *error = nil;
    _valdiContent = [OpenCraftValdiMainRuntime() loadViewWithComponentPath:@"MobileNativeOverlay@opencraft_design_valdi/src/MobileNativeOverlay"
                                                                     owner:nil
                                                                 viewModel:[self buildMergedViewModel]
                                                          componentContext:nil
                                                                     error:&error];
    if (_valdiContent) {
        _valdiContent.frame = self.bounds;
        _valdiContent.backgroundColor = [UIColor clearColor];
        _valdiContent.opaque = NO;
        _valdiContent.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
        [self addSubview:_valdiContent];
    } else {
        NSLog(@"[OpenCraftNative] Failed to mount Valdi MobileNativeOverlay: %@", error);
    }
}

- (void)applyState:(NSDictionary<NSString *, id> *)state
  interactiveModal:(BOOL)interactiveModal
floatingControlVisible:(BOOL)floatingControlVisible {
    _lastState = [state copy] ?: @{};
    _interactiveModal = interactiveModal;
    _floatingControlVisible = floatingControlVisible;
    BOOL needsDisplay = interactiveModal || floatingControlVisible;
    if (needsDisplay) {
        [self ensureValdiMounted];
    }
    if (_valdiContent) {
        _valdiContent.valdiContext.viewModel = [self buildMergedViewModel];
        _valdiContent.hidden = !needsDisplay;
    }
    self.userInteractionEnabled = needsDisplay;
}

- (BOOL)pointInside:(CGPoint)point withEvent:(UIEvent *)event {
    if (!self.userInteractionEnabled || self.hidden) {
        return NO;
    }
    if (_interactiveModal) {
        return [super pointInside:point withEvent:event];
    }
    if (_floatingControlVisible) {
        // Only intercept touches around the right-edge 44x44 floating pill so WKWebView receives all other touches.
        CGFloat pillSize = 56.0;
        CGRect hitRect = CGRectMake(
            MAX(0.0, self.bounds.size.width - _safeRight - 10.0 - pillSize),
            (self.bounds.size.height - pillSize) * 0.5,
            pillSize + 10.0,
            pillSize
        );
        return CGRectContainsPoint(hitRect, point);
    }
    return NO;
}

- (void)safeAreaInsetsDidChange {
    [super safeAreaInsetsDidChange];
    UIEdgeInsets insets = self.safeAreaInsets;
    if (fabs(_safeTop - insets.top) < 0.5 && fabs(_safeBottom - insets.bottom) < 0.5 && fabs(_safeRight - insets.right) < 0.5) {
        return;
    }
    _safeTop = insets.top;
    _safeBottom = insets.bottom;
    _safeRight = insets.right;
    if (_valdiContent) {
        _valdiContent.valdiContext.viewModel = [self buildMergedViewModel];
    }
}

- (void)handleKeyboardNotification:(NSNotification *)note {
    CGRect endFrame = [note.userInfo[UIKeyboardFrameEndUserInfoKey] CGRectValue];
    CGFloat nextHeight = 0;
    if (![note.name isEqualToString:UIKeyboardWillHideNotification] && self.window) {
        CGRect localFrame = [self convertRect:endFrame fromView:nil];
        CGRect overlap = CGRectIntersection(self.bounds, localFrame);
        if (!CGRectIsNull(overlap) && overlap.size.height > 0) {
            nextHeight = overlap.size.height;
        }
    }
    if (fabs(_keyboardHeight - nextHeight) < 0.5) return;
    _keyboardHeight = nextHeight;
    if (_valdiContent) {
        _valdiContent.valdiContext.viewModel = [self buildMergedViewModel];
    }
}

@end
