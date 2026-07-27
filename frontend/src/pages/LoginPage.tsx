import { Button, Card, Form, Input, theme, Typography, message } from "antd";
import { LockOutlined, PhoneOutlined } from "@ant-design/icons";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { errorMessage, POST_LOGIN_REDIRECT_KEY } from "../api/client";
import { useAuth } from "../auth/AuthContext";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const { token } = theme.useToken();

  const onFinish = async (values: { phone: string; password: string }) => {
    setSubmitting(true);
    try {
      await login(values.phone, values.password);
      const redirect = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY);
      sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
      // role-aware landing when there's nowhere specific to return to: the
      // layout menu adapts to capabilities.
      navigate(redirect || "/");
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: token.colorBgLayout,
      }}
    >
      <Card style={{ width: 380 }}>
        <Typography.Title level={3} style={{ textAlign: "center" }}>
          Rudrayani CRM
        </Typography.Title>
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item
            name="phone"
            label="Phone"
            rules={[{ required: true, pattern: /^\d{8,15}$/, message: "Enter your phone number" }]}
          >
            <Input prefix={<PhoneOutlined />} placeholder="9999999999" maxLength={15} />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="Password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={submitting}>
            Log in
          </Button>
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <Link to="/forgot-password">Forgot password?</Link>
          </div>
        </Form>
      </Card>
    </div>
  );
}
