import { Navigate } from "react-router-dom";

export const SignUpPage = () => {
  return <Navigate to="/auth/sign-in" replace />;
};
