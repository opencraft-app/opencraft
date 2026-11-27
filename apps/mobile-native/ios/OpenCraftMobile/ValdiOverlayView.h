#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface ValdiOverlayView : UIView

@property (nonatomic, copy, nullable) void (^onOpenSourceSettings)(void);
@property (nonatomic, copy, nullable) void (^onCloseOverlay)(void);
@property (nonatomic, copy, nullable) void (^onSaveSource)(NSString *kind, NSString *url);
@property (nonatomic, copy, nullable) void (^onConfirmResult)(BOOL confirmed);
@property (nonatomic, copy, nullable) void (^onActionSheetResult)(NSString * _Nullable actionId);
@property (nonatomic, copy, nullable) void (^onWelcomeConnect)(void);
@property (nonatomic, copy, nullable) void (^onWelcomeExplore)(void);
@property (nonatomic, copy, nullable) void (^onWelcomeStyleLab)(void);
@property (nonatomic, copy, nullable) void (^onWelcomeThemePref)(NSString *pref);

- (void)applyState:(NSDictionary<NSString *, id> *)state
  interactiveModal:(BOOL)interactiveModal
floatingControlVisible:(BOOL)floatingControlVisible;

- (void)triggerHapticStyle:(NSString *)style;

@end

NS_ASSUME_NONNULL_END
