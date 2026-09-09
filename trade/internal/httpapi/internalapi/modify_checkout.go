package internalapi

import (
	"errors"
	"git.woa.com/wisp/mono/trade/internal/logic/placeorder"
	"github.com/gin-gonic/gin"
	"net/http"
)

func modifyCheckoutHandler(svc *placeorder.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct {
			UserID string `json:"external_user_id"`
			PassID string `json:"resource_id"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(400, gin.H{"code": "InvalidRequest"})
			return
		}
		out, err := svc.FindModifyCheckout(c.Request.Context(), body.UserID, body.PassID)
		if err != nil {
			status, code := 500, "InternalError"
			if errors.Is(err, placeorder.ErrInvalidInput) {
				status, code = 400, "InvalidRequest"
			}
			if errors.Is(err, placeorder.ErrModifyCheckoutConflict) {
				status, code = 409, "ModifyCheckoutConflict"
			}
			c.JSON(status, gin.H{"code": code, "message": "unable to recover modify checkout"})
			return
		}
		c.JSON(http.StatusOK, out)
	}
}
